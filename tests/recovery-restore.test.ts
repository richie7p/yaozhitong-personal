import {expect,it} from "vitest";
import {quarantinedFileOwners} from "../tools/ops-complete-restore.js";
import {validateCreatedRestoreObjects} from "../tools/ops-recovery-cleanup.js";
import type {RecoveryPlan} from "../tools/recovery-core.js";
it("a missing current Auth or profile cannot resurrect a snapshot owner's uploads",()=>{
  const users=[{localId:"owner"}],guards=[{id:"owner"}];
  expect(quarantinedFileOwners(users,guards,users,guards).has("owner")).toBe(false);
  expect(quarantinedFileOwners(users,guards,[],guards).has("owner")).toBe(true);
  expect(quarantinedFileOwners(users,guards,users,[]).has("owner")).toBe(true);
  for(const guard of [{id:"owner",disabled:true},{id:"owner",deleting:true},{id:"owner",deletedAt:"2026-10-23"}]){
    expect(quarantinedFileOwners(users,[guard],users,guards).has("owner")).toBe(true);
    expect(quarantinedFileOwners(users,guards,users,[guard]).has("owner")).toBe(true);
  }
  expect(quarantinedFileOwners([{localId:"owner",disabled:true}],guards,users,guards).has("owner")).toBe(true);
  expect(quarantinedFileOwners(users,guards,[{localId:"owner",disabled:true}],guards).has("owner")).toBe(true);
});
it("cleanup accepts only a completed journal with exact created generations in its isolated prefix",()=>{
  const plan={backupBucket:"private-backup",maxObjects:10} as RecoveryPlan;
  const journal={schema:"complete-file-restore/v1",status:"all_selected_files_restored_and_verified",backupBucket:plan.backupBucket,snapshotId:"fixed-snapshot",prefix:"drills/fixed-snapshot/restored/",createdObjects:[{name:"drills/fixed-snapshot/restored/catalog/one",sourceName:"catalog/one",generation:"123"}]};
  expect(validateCreatedRestoreObjects(journal,plan)).toHaveLength(1);
  for(const change of [{status:"partial"},{backupBucket:"source-bucket"},{prefix:"snapshots/fixed-snapshot/"},{createdObjects:[{...journal.createdObjects[0],name:"snapshots/important.enc"}]},{createdObjects:[{...journal.createdObjects[0],generation:"latest"}]},{createdObjects:[...journal.createdObjects,...journal.createdObjects]}])expect(()=>validateCreatedRestoreObjects({...journal,...change},plan)).toThrow();
});
