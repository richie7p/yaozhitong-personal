import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Storage } from "@google-cloud/storage";
import { assertPrivateBucket, assertRestoreTarget, comparableAuthProviders, decryptRecovery, objectIdentity, objectRestoreDecision, prepareQuarantinedAuthImport, quarantineMetadata, sha256, stableJson, validateRecoveryPlan, type RecoveryPlan } from "./recovery-core.js";
import { exportAuth, mapRecovery, readDeletionGuards, readRecoveryKey, recoveryClient, safeCloudRequest } from "./recovery-backup.js";

export interface SnapshotPin { snapshotId:string; manifestObject:string; manifestGeneration:string; manifestCiphertextSha256:string; }
interface AccountIdentity {localId:string;disabled?:boolean;}
interface AccountGuard {id:string;disabled?:boolean;deleting?:boolean;deletedAt?:unknown;}
export function quarantinedFileOwners(snapshotUsers:AccountIdentity[],snapshotGuards:AccountGuard[],currentUsers:AccountIdentity[],currentGuards:AccountGuard[]){
  const authIds=new Set(currentUsers.map(u=>u.localId)),profileIds=new Set(currentGuards.map(g=>g.id));
  const allIds=new Set([...snapshotUsers,...currentUsers].map(u=>u.localId).concat([...snapshotGuards,...currentGuards].map(g=>g.id)));
  const quarantined=new Set([...allIds].filter(id=>!authIds.has(id)||!profileIds.has(id)));
  for(const user of [...snapshotUsers,...currentUsers])if(user.disabled)quarantined.add(user.localId);
  for(const guard of [...snapshotGuards,...currentGuards])if(guard.disabled||guard.deleting||guard.deletedAt)quarantined.add(guard.id);
  return quarantined;
}
export async function openRecoverySnapshot(plan:RecoveryPlan,pin:SnapshotPin){
  if(!/^[a-zA-Z0-9TZ.-]+$/.test(pin.snapshotId)||pin.manifestObject!==`snapshots/${pin.snapshotId}/manifest.enc`||!/^\d+$/.test(pin.manifestGeneration)||!/^[a-f0-9]{64}$/.test(pin.manifestCiphertextSha256))throw Error("invalid_recovery_snapshot_pin");
  const storage=new Storage({projectId:plan.sourceProject,retryOptions:{autoRetry:false}}),client=await recoveryClient();
  const [meta]=await storage.bucket(plan.backupBucket).getMetadata();assertPrivateBucket(meta,plan.backupBucket,plan.sourceProjectNumber);
  const key=await readRecoveryKey(client,plan.backupKeyVersion);
  try {
    const [encrypted]=await storage.bucket(plan.backupBucket).file(pin.manifestObject,{generation:pin.manifestGeneration}).download({validation:"crc32c"});
    if(sha256(encrypted)!==pin.manifestCiphertextSha256)throw Error("manifest_ciphertext_pin_changed");
    const manifest=JSON.parse(decryptRecovery(encrypted,key,"manifest/"+pin.snapshotId).toString("utf8"));
    if(manifest.schema!=="yzt-complete-recovery-manifest/v1"||manifest.snapshotId!==pin.snapshotId||stableJson(manifest.plan)!==stableJson(plan)||!Array.isArray(manifest.objects)||manifest.objects.length>plan.maxObjects||manifest.objects.reduce((n:number,o:any)=>n+o.size,0)>plan.maxBytes)throw Error("manifest_identity_or_limits_failed");
    if(!Number.isFinite(Date.parse(manifest.startedAt))||!Number.isFinite(Date.parse(manifest.completedAt))||Date.parse(manifest.startedAt)>Date.parse(manifest.completedAt))throw Error("invalid_recovery_snapshot_times");
    if(Date.parse(manifest.completedAt)+plan.retentionDays*86400000<Date.now())throw Error("expired_recovery_snapshot");
    const names=new Set<string>();
    for(const o of manifest.objects){if(names.has(o.name)||stableJson(objectIdentity(o.metadata))!==stableJson({name:o.name,generation:o.generation,metageneration:o.metageneration,size:o.size}))throw Error("manifest_object_identity_failed");
      if(o.backupDisposition==="expired_not_copied"){if(!o.name.startsWith("uploads/")||!Number.isFinite(Date.parse(o.expiresAt))||Date.parse(o.expiresAt)>Date.parse(manifest.startedAt)||o.backupObject!==null||o.backupGeneration!==null)throw Error("invalid_expired_object_manifest_entry");}
      else if(typeof o.backupObject!=="string"||!o.backupObject.startsWith(`snapshots/${pin.snapshotId}/objects/`)||!/^\d+$/.test(o.backupGeneration)||!/^[a-f0-9]{64}$/.test(o.plaintextSha256)||!/^[a-f0-9]{64}$/.test(o.ciphertextSha256))throw Error("manifest_object_cipher_pin_failed");names.add(o.name);}
    const authObject=manifest.auth;
    if(authObject.object!==`snapshots/${pin.snapshotId}/auth.enc`)throw Error("manifest_auth_identity_failed");
    const [authEncrypted]=await storage.bucket(plan.backupBucket).file(authObject.object,{generation:authObject.generation}).download();
    if(sha256(authEncrypted)!==authObject.ciphertextSha256)throw Error("auth_ciphertext_pin_changed");
    const plain=decryptRecovery(authEncrypted,key,"auth/"+pin.snapshotId);if(sha256(plain)!==authObject.plaintextSha256)throw Error("auth_plaintext_pin_changed");
    const auth=JSON.parse(plain.toString("utf8"));if(auth.project!==plan.sourceProject||auth.users.length>plan.maxAuthUsers)throw Error("auth_snapshot_identity_failed");
    return {storage,client,key,manifest,auth};
  }catch(e){key.fill(0);throw e;}
}
export async function restoreFiles(plan:RecoveryPlan,pin:SnapshotPin,receipts:string,execute:boolean){
  const opened=await openRecoverySnapshot(plan,pin);const {storage,key,manifest,auth}=opened;
  const prefix=`drills/${pin.snapshotId}/restored/`;
  const bucket=storage.bucket(plan.backupBucket);
  try {
    const [existing]=await bucket.getFiles({prefix,maxResults:1,autoPaginate:false});if(existing.length)throw Error("restore_prefix_not_empty_reconcile_before_retry");
    const [guards,currentAuth]=await Promise.all([readDeletionGuards(plan.sourceProject),exportAuth(opened.client,plan.sourceProject,plan.maxAuthUsers)]);
    const quarantined=quarantinedFileOwners(auth.users,auth.guards,currentAuth,guards);
    const selected=manifest.objects.filter((o:any)=>objectRestoreDecision(o,quarantined,new Date())==="restore");
    await fs.mkdir(receipts,{recursive:true});
    const journal:any={schema:"complete-file-restore/v1",snapshotId:pin.snapshotId,backupBucket:plan.backupBucket,prefix,status:execute?"intent_frozen":"read_only_preflight_passed",selectedObjects:selected.length,excludedObjects:manifest.objects.length-selected.length,createdObjects:[],sourceWrites:0};
    const file=path.join(receipts,execute?"file-restore-journal.json":"file-restore-preflight.json");await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n",{flag:"wx"});
    let journalTail=Promise.resolve();
    const saveJournal=()=>{const data=JSON.stringify(journal,null,2)+"\n";journalTail=journalTail.then(()=>fs.writeFile(file,data));return journalTail;};
    if(!execute)return {status:journal.status,selectedObjects:selected.length,excludedObjects:journal.excludedObjects,cloudWrites:0};
    const records=await mapRecovery<any,any>(selected,plan.concurrency,async(o)=>{
      const [encrypted]=await bucket.file(o.backupObject,{generation:o.backupGeneration}).download({validation:"crc32c"});if(sha256(encrypted)!==o.ciphertextSha256)throw Error("backup_object_ciphertext_changed");
      const plain=decryptRecovery(encrypted,key,"object/"+pin.snapshotId+"/"+o.backupObject);if(plain.length!==o.size||sha256(plain)!==o.plaintextSha256)throw Error("backup_object_plaintext_changed");
      const target=bucket.file(prefix+o.name),metadata=quarantineMetadata(o.metadata);
      if(o.name.startsWith("uploads/")){
        if(!Number.isFinite(Date.parse(o.expiresAt)))throw Error("upload_restore_expiry_required");
        metadata.customTime=new Date(Date.parse(o.expiresAt)-86400000).toISOString();
      }
      await target.save(plain,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata});
      const [targetMeta]=await target.getMetadata();
      const record={name:target.name,generation:String(targetMeta.generation),plaintextSha256:o.plaintextSha256,size:o.size,sourceName:o.name,metadataAdjustedForQuarantine:true};
      journal.createdObjects.push(record);
      await saveJournal();
      const [reread]=await bucket.file(target.name,{generation:record.generation}).download({validation:"crc32c",decompress:false});
      const observedMetadata=quarantineMetadata(targetMeta);if(metadata.customTime)observedMetadata.customTime=targetMeta.customTime;
      if(sha256(reread)!==o.plaintextSha256||reread.length!==o.size||stableJson(observedMetadata)!==stableJson(metadata))throw Error("restored_file_content_or_safe_metadata_mismatch");
      return record;
    });
    journal.createdObjects=records;journal.status="all_selected_files_restored_and_verified";journal.completedAt=new Date().toISOString();await saveJournal();
    return {status:journal.status,objects:records.length,bytes:records.reduce((n:any,r:any)=>n+r.size,0),sourceWrites:0,defaultAuthWrites:0,prefix};
  }finally{key.fill(0);}
}
export async function restoreAuth(plan:RecoveryPlan,pin:SnapshotPin,targetProject:string,targetProjectNumber:string,receipts:string,execute:boolean){
  const opened=await openRecoverySnapshot(plan,pin);const {client,key,auth}=opened;
  try {
    const observed=await safeCloudRequest(client,"https://cloudresourcemanager.googleapis.com/v1/projects/"+targetProject);assertRestoreTarget(plan.sourceProject,targetProject,targetProjectNumber,observed);
    const existing=await exportAuth(client,targetProject,plan.maxAuthUsers);if(existing.length)throw Error("auth_restore_target_not_empty_reconcile_before_retry");
    const [current,guards]=await Promise.all([exportAuth(client,plan.sourceProject,plan.maxAuthUsers),readDeletionGuards(plan.sourceProject)]);
    const deleted=new Set<string>(guards.filter(g=>g.deleting||g.deletedAt).map(g=>g.id));
    const body=prepareQuarantinedAuthImport(auth.users,auth.authConfig.signIn.hashConfig,new Set(current.map(u=>u.localId)),deleted);
    await fs.mkdir(receipts,{recursive:true});const file=path.join(receipts,execute?"auth-restore-journal.json":"auth-restore-preflight.json");
    const journal:any={schema:"complete-auth-restore/v1",snapshotId:pin.snapshotId,targetProject,targetProjectNumber,users:body.users.length,excludedUsers:auth.users.length-body.users.length,allUsersDisabled:true,allowOverwrite:false,status:execute?"intent_before_single_import":"read_only_preflight_passed",sourceAuthWrites:0,emailsSent:0};await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n",{flag:"wx"});
    if(!execute)return {...journal,cloudWrites:0};
    let response:any;
    try{response=await safeCloudRequest(client,`https://identitytoolkit.googleapis.com/v1/projects/${targetProject}/accounts:batchCreate`,"POST",body);}catch(e){journal.status="import_outcome_requires_readonly_reconciliation";await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n");throw e;}
    if(response.error?.length){journal.status="partial_import_do_not_retry";journal.errorCount=response.error.length;await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n");throw Error("auth_import_partial_failure");}
    const imported=await exportAuth(client,targetProject,plan.maxAuthUsers);
    if(imported.length!==body.users.length)throw Error("auth_import_user_count_mismatch");
    const map=new Map(imported.map(u=>[u.localId,u]));
    const counts={uid:0,email:0,emailVerified:0,passwordHash:0,salt:0,claims:0,providers:0,disabled:0};
    const sourceMap=new Map<string,any>(auth.users.map((u:any)=>[u.localId,u]));
    for(const expected of body.users){const actual=map.get(expected.localId);if(!actual||actual.disabled!==true)throw Error("auth_quarantine_not_retained");counts.uid++;counts.disabled++;
      for(const [field,count]of [["email","email"],["emailVerified","emailVerified"],["passwordHash","passwordHash"],["salt","salt"]] as const){if(stableJson(actual[field]??(field==="emailVerified"?false:null))!==stableJson(expected[field]??(field==="emailVerified"?false:null)))throw Error("auth_import_metadata_mismatch_"+field);if(expected[field]!==undefined)counts[count]++;}
      if(stableJson(JSON.parse(actual.customAttributes||"{}"))!==stableJson(JSON.parse(expected.customAttributes||"{}")))throw Error("auth_import_metadata_mismatch_customAttributes");if(expected.customAttributes)counts.claims++;
      if(stableJson(comparableAuthProviders(actual))!==stableJson(comparableAuthProviders(sourceMap.get(expected.localId))))throw Error("auth_import_metadata_mismatch_providerUserInfo");if(actual.providerUserInfo?.length)counts.providers++;
    }
    Object.assign(journal,{status:"all_users_imported_quarantined_and_verified",verified:counts,completedAt:new Date().toISOString()});await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n");
    return journal;
  }finally{key.fill(0);}
}
async function main(){const args=process.argv.slice(2);const value=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error("missing_restore_argument");return args[i+1]};const plan=validateRecoveryPlan(JSON.parse(await fs.readFile(value("--plan"),"utf8")));const pin=JSON.parse(await fs.readFile(value("--snapshot-pin"),"utf8"));const execute=args.includes("--execute"),receipts=path.resolve(value("--receipts"));let result;if(value("--component")==="files")result=await restoreFiles(plan,pin,receipts,execute);else if(value("--component")==="auth")result=await restoreAuth(plan,pin,value("--target-project"),value("--target-project-number"),receipts,execute);else throw Error("unknown_restore_component");console.log(JSON.stringify(result));}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href)main().catch(e=>{console.error(JSON.stringify({status:"failed",code:/^[a-zA-Z0-9_]+$/.test(e.message)?e.message:"restore_failed_redacted"}));process.exitCode=1;});
