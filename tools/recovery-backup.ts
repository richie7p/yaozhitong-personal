import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { Storage } from "@google-cloud/storage";
import { initializeApp, applicationDefault, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { assertPrivateBucket, authCriticalProjection, confirmedUploadOwner, decryptRecovery, encryptRecovery, objectIdentity, sha256, stableJson, uploadRetentionTimes, type RecoveryPlan, type RecoveryObject } from "./recovery-core.js";

export async function recoveryClient() {
  return new GoogleAuth({scopes:["https://www.googleapis.com/auth/cloud-platform"]}).getClient();
}
export async function safeCloudRequest(client: any, url: string, method = "GET", data?: unknown) {
  try { return (await client.request({url,method,data,retry:false,timeout:60000})).data; }
  catch(e: any) { const code=String(e.response?.data?.error?.message||"").match(/^([A-Z][A-Z0-9_]{2,})(?:\s|:|$)/)?.[1];throw Error("recovery_cloud_request_failed_http_" + Number(e.response?.status || 0)+(code?"_"+code:"")); }
}
export async function exportAuth(client: any, project: string, max: number) {
  const users: any[] = []; let token: string | undefined;
  do {
    const url=new URL(`https://identitytoolkit.googleapis.com/v1/projects/${project}/accounts:batchGet`);
    url.searchParams.set("maxResults",String(Math.min(1000,max+1)));
    if(token) url.searchParams.set("nextPageToken",token);
    const result=await safeCloudRequest(client,url.href);users.push(...(result.users || []));
    if(users.length>max) throw Error("auth_backup_limit_exceeded");
    token=result.nextPageToken;
  } while(token);
  return users.sort((a,b)=>a.localId.localeCompare(b.localId,"en"));
}
export async function readProviderConfigs(client:any,project:string){
  const result:Record<string,unknown>={};
  for(const field of ["defaultSupportedIdpConfigs","inboundSamlConfigs","oauthIdpConfigs"]){
    const values:any[]=[];let token:string|undefined;
    do {const url=new URL(`https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/${field}`);url.searchParams.set("pageSize","100");if(token)url.searchParams.set("pageToken",token);const response=await safeCloudRequest(client,url.href);values.push(...(response[field]||[]));if(values.length>1000)throw Error("provider_config_backup_limit_exceeded");token=response.nextPageToken;}while(token);
    result[field]=values;
  }
  return result;
}
export async function readDeletionGuards(project: string) {
  const app=initializeApp({credential:applicationDefault(),projectId:project},"recovery-guards-"+randomBytes(6).toString("hex"));
  try {
    const docs=await getFirestore(app).collection("users").limit(10001).get();
    if(docs.size>10000) throw Error("deletion_guard_limit_exceeded");
    return docs.docs.map(d=>({id:d.id,disabled:d.data().disabled===true,deleting:d.data().deleting===true,deletedAt:d.data().deletedAt||null})).sort((a,b)=>a.id.localeCompare(b.id,"en"));
  } finally { await deleteApp(app); }
}
export async function readRecoveryKey(client: any, version: string) {
  const result=await safeCloudRequest(client,"https://secretmanager.googleapis.com/v1/"+version+":access");
  const key=Buffer.from(result.payload?.data||"","base64");
  if(key.length!==32) throw Error("recovery_key_invalid_length");
  return key;
}
export async function listSourceObjects(storage: Storage, plan: RecoveryPlan) {
  const files: any[]=[]; let query: any={autoPaginate:false,maxResults:1000,versions:false};
  do {
    const [batch,next]=await storage.bucket(plan.sourceBucket).getFiles(query);files.push(...batch.map(f=>f.metadata));
    if(files.length>plan.maxObjects || files.reduce((n,f)=>n+Number(f.size),0)>plan.maxBytes || batch.some(f=>Number(f.metadata.size)>(plan.maxObjectBytes||33554432))) throw Error("storage_backup_limit_exceeded");
    query=next;
  }while(query);
  return files.sort((a,b)=>a.name.localeCompare(b.name,"en"));
}
export async function mapRecovery<T,R>(items:T[],concurrency:number,fn:(item:T,index:number)=>Promise<R>) {
  let index=0;let failure:unknown;const out=new Array<R>(items.length);
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(index<items.length&&!failure){const i=index++;try{out[i]=await fn(items[i],i);}catch(error){failure=error;}}}));
  if(failure)throw failure;
  return out;
}
export async function performCompleteBackup(plan:RecoveryPlan, receipts:string, execute:boolean) {
  const client=await recoveryClient(),storage=new Storage({projectId:plan.sourceProject,retryOptions:{autoRetry:false}});
  const project=await safeCloudRequest(client,"https://cloudresourcemanager.googleapis.com/v1/projects/"+plan.sourceProject);
  if(String(project.projectNumber)!==plan.sourceProjectNumber) throw Error("backup_source_project_identity_changed");
  const [sourceMeta]=await storage.bucket(plan.sourceBucket).getMetadata();
  if(String(sourceMeta.projectNumber)!==plan.sourceProjectNumber) throw Error("backup_source_bucket_project_changed");
  const [backupMeta]=await storage.bucket(plan.backupBucket).getMetadata();assertPrivateBucket(backupMeta,plan.backupBucket,plan.sourceProjectNumber);
  const [users,authConfig,objects,guards,sourceIam,providerConfigs]=await Promise.all([
    exportAuth(client,plan.sourceProject,plan.maxAuthUsers),
    safeCloudRequest(client,`https://identitytoolkit.googleapis.com/admin/v2/projects/${plan.sourceProject}/config`),
    listSourceObjects(storage,plan),readDeletionGuards(plan.sourceProject),storage.bucket(plan.sourceBucket).iam.getPolicy(),readProviderConfigs(client,plan.sourceProject),
  ]);
  const hash=authConfig.signIn?.hashConfig;
  if(hash?.algorithm!=="SCRYPT" || !hash.signerKey || !hash.saltSeparator) throw Error("full_password_hash_configuration_unavailable");
  for(const user of users) if((user.providerUserInfo||[]).some((p:any)=>p.providerId==="password") && (!user.passwordHash || !user.salt)) throw Error("password_hash_export_incomplete");
  const preflight={at:new Date().toISOString(),sourceProject:plan.sourceProject,sourceBucket:plan.sourceBucket,backupBucket:plan.backupBucket,authUsers:users.length,passwordHashUsers:users.filter(u=>u.passwordHash).length,objects:objects.length,bytes:objects.reduce((n,f)=>n+Number(f.size),0),guardDocuments:guards.length,execute};
  await fs.mkdir(receipts,{recursive:true});
  await fs.writeFile(path.join(receipts,execute?"backup-preflight-execute.json":"backup-preflight-readonly.json"),JSON.stringify(preflight,null,2)+"\n",{flag:"wx"});
  if(!execute) return {...preflight,status:"read_only_preflight_passed",cloudWrites:0};
  const snapshotId=new Date().toISOString().replace(/[:.]/g,"-")+"-"+randomBytes(4).toString("hex");
  const prefix="snapshots/"+snapshotId+"/";
  const journal:any={schema:"complete-backup-journal/v1",...preflight,snapshotId,prefix,status:"intent_frozen",objectsCompleted:0};
  const journalPath=path.join(receipts,"backup-journal.json");await fs.writeFile(journalPath,JSON.stringify(journal,null,2)+"\n",{flag:"wx"});
  const save=()=>fs.writeFile(journalPath,JSON.stringify(journal,null,2)+"\n");
  const key=await readRecoveryKey(client,plan.backupKeyVersion);
  try {
    const authPlain=Buffer.from(stableJson({schema:"complete-auth-snapshot/v1",project:plan.sourceProject,users,authConfig,providerConfigs,guards}));
    const authEnvelope=encryptRecovery(authPlain,key,"auth/"+snapshotId);
    const authFile=storage.bucket(plan.backupBucket).file(prefix+"auth.enc");
    await authFile.save(authEnvelope,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:"application/octet-stream",cacheControl:"private, no-store"}});
    const [authStored]=await authFile.download();if(!authStored.equals(authEnvelope)||!decryptRecovery(authStored,key,"auth/"+snapshotId).equals(authPlain)) throw Error("auth_backup_readback_failed");
    const [authMetadata]=await authFile.getMetadata();
    const authIds=new Set(users.map(u=>u.localId));
    const knownOwners=new Set<string>([...guards.filter(g=>authIds.has(g.id)||g.disabled||g.deleting||g.deletedAt).map(g=>g.id),...users.filter(u=>u.disabled).map(u=>u.localId)]);
    const copied=await mapRecovery(objects,plan.concurrency,async(metadata,index):Promise<RecoveryObject>=>{
      const identity=objectIdentity(metadata);
      const retention=identity.name.startsWith("uploads/")?uploadRetentionTimes(metadata):undefined;
      const ownerId=confirmedUploadOwner(identity.name,metadata.metadata?.ownerId,knownOwners);
      if(retention&&Date.parse(retention.expiresAt)<=Date.parse(preflight.at)){
        journal.objectsCompleted++;
        return {...identity,metadata,plaintextSha256:null,ciphertextSha256:null,backupObject:null,backupGeneration:null,backupDisposition:"expired_not_copied",...(ownerId?{ownerId}:{}),expiresAt:retention.expiresAt};
      }
      const source=storage.bucket(plan.sourceBucket).file(identity.name,{generation:identity.generation});
      const [before]=await source.getMetadata();if(stableJson(objectIdentity(before))!==stableJson(identity))throw Error("source_object_changed_before_backup");
      const [plain]=await source.download({validation:"crc32c",decompress:false});
      if(plain.length!==identity.size)throw Error("source_object_stored_size_mismatch");
      const [after]=await source.getMetadata();if(stableJson(before)!==stableJson(after))throw Error("source_metadata_changed_during_backup");
      const name=prefix+"objects/"+sha256(stableJson(identity))+".enc";
      const envelope=encryptRecovery(plain,key,"object/"+snapshotId+"/"+name);
      const backup=storage.bucket(plan.backupBucket).file(name);
      await backup.save(envelope,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:"application/octet-stream",cacheControl:"private, no-store",...(retention?{customTime:retention.customTime}:{})}});
      const [reread]=await backup.download({validation:"crc32c"});
      if(sha256(reread)!==sha256(envelope)||sha256(decryptRecovery(reread,key,"object/"+snapshotId+"/"+name))!==sha256(plain))throw Error("encrypted_object_readback_failed");
      const [bm]=await backup.getMetadata();
      journal.objectsCompleted++;if(journal.objectsCompleted%100===0) await save();
      const expiry=retention?.expiresAt;
      return {...identity,metadata,plaintextSha256:sha256(plain),ciphertextSha256:sha256(envelope),backupObject:name,backupGeneration:String(bm.generation),backupDisposition:"encrypted",...(ownerId?{ownerId}:{}),...(expiry?{expiresAt:expiry}:{})};
    });
    const [usersAfter,guardsAfter,objectsAfter]=await Promise.all([exportAuth(client,plan.sourceProject,plan.maxAuthUsers),readDeletionGuards(plan.sourceProject),listSourceObjects(storage,plan)]);
    if(stableJson(users.map(authCriticalProjection))!==stableJson(usersAfter.map(authCriticalProjection)) || stableJson(guards)!==stableJson(guardsAfter))throw Error("account_or_deletion_state_changed_during_backup");
    const afterMap=new Map(objectsAfter.map(o=>[o.name,o]));
    for(const o of objects)if(stableJson(o)!==stableJson(afterMap.get(o.name)))throw Error("original_object_changed_during_backup");
    const manifest={schema:"yzt-complete-recovery-manifest/v1",snapshotId,startedAt:preflight.at,completedAt:new Date().toISOString(),plan,sourceBucketMetadata:sourceMeta,sourceBucketIam:sourceIam[0],auth:{object:authFile.name,generation:authMetadata.generation,plaintextSha256:sha256(authPlain),ciphertextSha256:sha256(authEnvelope),users:users.length,passwordHashUsers:preflight.passwordHashUsers},objects:copied,postSnapshotNewObjects:objectsAfter.length-objects.length};
    const plain=Buffer.from(stableJson(manifest)),encrypted=encryptRecovery(plain,key,"manifest/"+snapshotId);
    const mf=storage.bucket(plan.backupBucket).file(prefix+"manifest.enc");await mf.save(encrypted,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:"application/octet-stream",cacheControl:"private, no-store"}});
    const [check]=await mf.download();if(!decryptRecovery(check,key,"manifest/"+snapshotId).equals(plain))throw Error("manifest_readback_failed");
    const [mm]=await mf.getMetadata();
    Object.assign(journal,{status:"complete_verified",completedAt:manifest.completedAt,manifestObject:mf.name,manifestGeneration:mm.generation,manifestCiphertextSha256:sha256(encrypted),manifestPlaintextSha256:sha256(plain),postSnapshotNewObjects:manifest.postSnapshotNewObjects});await save();
    return {...preflight,status:journal.status,snapshotId,manifestObject:mf.name,manifestGeneration:mm.generation,manifestCiphertextSha256:sha256(encrypted),objectsVerified:copied.filter(o=>o.backupDisposition!=="expired_not_copied").length,expiredObjectsNotCopied:copied.filter(o=>o.backupDisposition==="expired_not_copied").length};
  }catch(error){journal.status="incomplete_not_a_restorable_snapshot";journal.error="backup_failed_redacted";await save();throw error;}finally{key.fill(0);}
}
