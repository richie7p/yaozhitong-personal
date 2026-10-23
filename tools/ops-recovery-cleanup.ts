import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Storage } from "@google-cloud/storage";
import { assertPrivateBucket, assertRestoreTarget, authCriticalProjection, sha256, stableJson, validateRecoveryPlan, type RecoveryPlan } from "./recovery-core.js";
import { exportAuth, mapRecovery, recoveryClient, safeCloudRequest } from "./recovery-backup.js";
import { openRecoverySnapshot, type SnapshotPin } from "./ops-complete-restore.js";

export function validateCreatedRestoreObjects(journal:any,plan:RecoveryPlan){
  if(journal.schema!=="complete-file-restore/v1"||journal.status!=="all_selected_files_restored_and_verified"||journal.backupBucket!==plan.backupBucket||journal.prefix!==`drills/${journal.snapshotId}/restored/`||!Array.isArray(journal.createdObjects)||journal.createdObjects.length>plan.maxObjects)throw Error("cleanup_requires_exact_completed_isolated_restore_journal");
  const names=new Set<string>();
  for(const object of journal.createdObjects){if(typeof object.name!=="string"||object.name!==journal.prefix+object.sourceName||!object.name.startsWith(journal.prefix)||!/^\d+$/.test(object.generation)||names.has(object.name))throw Error("invalid_cleanup_created_object_identity");names.add(object.name);}
  return journal.createdObjects as {name:string;generation:string;sourceName:string}[];
}
export async function cleanupRestoredFiles(plan:RecoveryPlan,journalPath:string,expectedSha:string,receipts:string,execute:boolean){
  const bytes=await fs.readFile(journalPath);if(sha256(bytes)!==expectedSha)throw Error("cleanup_journal_pin_changed");
  const original=JSON.parse(bytes.toString("utf8")),objects=validateCreatedRestoreObjects(original,plan);
  const storage=new Storage({projectId:plan.sourceProject,retryOptions:{autoRetry:false}}),bucket=storage.bucket(plan.backupBucket);
  const[metadata]=await bucket.getMetadata();assertPrivateBucket(metadata,plan.backupBucket,plan.sourceProjectNumber);
  const[existing]=await bucket.getFiles({prefix:original.prefix});
  if(existing.length!==objects.length)throw Error("cleanup_prefix_set_changed");
  const expected=new Map(objects.map(o=>[o.name,o.generation]));for(const file of existing)if(expected.get(file.name)!==String(file.metadata.generation))throw Error("cleanup_created_generation_changed");
  const journal:any={schema:"complete-file-restore-cleanup/v1",at:new Date().toISOString(),restoreJournalSha256:expectedSha,backupBucket:plan.backupBucket,prefix:original.prefix,status:execute?"intent_before_exact_generation_cleanup":"read_only_preflight_passed",expectedObjects:objects.length,deletedObjects:0,sourceObjectWrites:0,backupSnapshotWrites:0};
  await fs.mkdir(receipts,{recursive:true});const file=path.join(receipts,execute?"file-cleanup-journal.json":"file-cleanup-preflight.json");await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n",{flag:"wx"});
  if(!execute)return journal;
  let tail=Promise.resolve();const save=()=>{const bytes=JSON.stringify(journal,null,2)+"\n";tail=tail.then(()=>fs.writeFile(file,bytes));return tail;};
  await mapRecovery(objects,4,async(o)=>{await bucket.file(o.name,{generation:o.generation}).delete({ifGenerationMatch:o.generation});journal.deletedObjects++;if(journal.deletedObjects%100===0)await save();});
  const[remaining]=await bucket.getFiles({prefix:original.prefix,maxResults:1,autoPaginate:false});if(remaining.length)throw Error("cleanup_prefix_not_empty");
  journal.status="exact_created_generations_removed_prefix_empty";journal.completedAt=new Date().toISOString();await save();return journal;
}
export async function cleanupIsolatedAuthProject(plan:RecoveryPlan,pin:SnapshotPin,creationPath:string,expectedCreationSha:string,receipts:string,execute:boolean){
  const bytes=await fs.readFile(creationPath);if(sha256(bytes)!==expectedCreationSha)throw Error("project_creation_receipt_pin_changed");
  const creation=JSON.parse(bytes.toString("utf8"));const target=creation.targetProject;
  if(!target?.projectId||!target.projectNumber||Date.now()-Date.parse(target.createTime)>86400000)throw Error("fresh_project_creation_receipt_required");
  const opened=await openRecoverySnapshot(plan,pin);const {client,key,auth}=opened;
  try{
    const observed=await safeCloudRequest(client,"https://cloudresourcemanager.googleapis.com/v1/projects/"+target.projectId);assertRestoreTarget(plan.sourceProject,target.projectId,target.projectNumber,observed);
    const[users,sourceBefore]=await Promise.all([exportAuth(client,target.projectId,plan.maxAuthUsers),exportAuth(client,plan.sourceProject,plan.maxAuthUsers)]);
    if(users.some(u=>!u.disabled)||stableJson(users.map(u=>u.localId).sort())!==stableJson(auth.users.map((u:any)=>u.localId).sort()))throw Error("target_cleanup_exact_quarantined_user_set_required");
    const journal:any={schema:"isolated-auth-project-cleanup/v1",at:new Date().toISOString(),targetProject:target.projectId,targetProjectNumber:target.projectNumber,creationReceiptSha256:expectedCreationSha,status:execute?"intent_before_exact_imported_user_cleanup":"read_only_preflight_passed",usersBefore:users.length,sourceAuthWrites:0,sourceProjectDeletionRequests:0};
    await fs.mkdir(receipts,{recursive:true});const file=path.join(receipts,execute?"auth-project-cleanup-journal.json":"auth-project-cleanup-preflight.json");await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n",{flag:"wx"});const save=()=>fs.writeFile(file,JSON.stringify(journal,null,2)+"\n");
    if(!execute)return journal;
    const deleted=await safeCloudRequest(client,`https://identitytoolkit.googleapis.com/v1/projects/${target.projectId}/accounts:batchDelete`,"POST",{localIds:users.map(u=>u.localId),force:true});
    if(deleted.errors?.length)throw Error("target_auth_cleanup_partial_failure");
    const afterUsers=await exportAuth(client,target.projectId,plan.maxAuthUsers);if(afterUsers.length)throw Error("target_auth_cleanup_not_empty");
    journal.usersAfter=0;journal.status="imported_target_users_removed_before_project_delete";await save();
    const beforeDelete=await safeCloudRequest(client,"https://cloudresourcemanager.googleapis.com/v1/projects/"+target.projectId);assertRestoreTarget(plan.sourceProject,target.projectId,target.projectNumber,beforeDelete);
    await safeCloudRequest(client,"https://cloudresourcemanager.googleapis.com/v1/projects/"+target.projectId,"DELETE");
    const after=await safeCloudRequest(client,"https://cloudresourcemanager.googleapis.com/v1/projects/"+target.projectId);
    if(after.lifecycleState!=="DELETE_REQUESTED"||String(after.projectNumber)!==String(target.projectNumber))throw Error("isolated_project_deletion_readback_failed");
    const sourceAfter=await exportAuth(client,plan.sourceProject,plan.maxAuthUsers);if(stableJson(sourceBefore.map(authCriticalProjection))!==stableJson(sourceAfter.map(authCriticalProjection)))throw Error("source_auth_changed_during_cleanup");
    journal.status="isolated_auth_empty_project_delete_requested_source_unchanged";journal.sourceAuthFingerprintUnchanged=true;journal.projectLifecycleAfter=after.lifecycleState;journal.completedAt=new Date().toISOString();await save();return journal;
  }finally{key.fill(0);}
}
async function main(){const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error("missing_cleanup_argument");return args[i+1]};const plan=validateRecoveryPlan(JSON.parse(await fs.readFile(value("--plan"),"utf8")));const receipts=path.resolve(value("--receipts")),execute=args.includes("--execute");let result;if(value("--component")==="files")result=await cleanupRestoredFiles(plan,value("--restore-journal"),value("--journal-sha256"),receipts,execute);else if(value("--component")==="auth")result=await cleanupIsolatedAuthProject(plan,JSON.parse(await fs.readFile(value("--snapshot-pin"),"utf8")),value("--creation-receipt"),value("--creation-sha256"),receipts,execute);else throw Error("unknown_cleanup_component");console.log(JSON.stringify(result));}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href)main().catch(e=>{console.error(JSON.stringify({status:"failed",code:/^[a-zA-Z0-9_]+$/.test(e.message)?e.message:"cleanup_failed_redacted"}));process.exitCode=1;});
