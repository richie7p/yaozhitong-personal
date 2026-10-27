import { expect, it } from "vitest";
import { addExactIamMember, RECOVERY_ROLES, recoveryJobBody, recoverySchedulerBody, validateRecoveryDeployment } from "../tools/recovery-deployment.js";
const project="example-project";
const d={project,projectNumber:"123456",region:"asia-east1",job:"yzt-recovery-backup",scheduler:"yzt-recovery-daily",backupServiceAccount:`yzt-recovery-backup@${project}.iam.gserviceaccount.com`,triggerServiceAccount:`yzt-recovery-trigger@${project}.iam.gserviceaccount.com`,image:`asia-east1-docker.pkg.dev/${project}/yaozhitong/recovery@sha256:${"a".repeat(64)}`,backupPlan:{schema:"yzt-complete-backup-plan/v1" as const,sourceProject:project,sourceProjectNumber:"123456",sourceBucket:"private-source",backupBucket:"private-backup",backupKeyVersion:`projects/${project}/secrets/key/versions/1`,maxObjects:4000,maxBytes:600*1024*1024,maxAuthUsers:100,retentionDays:7,concurrency:4}};
it("daily worker has a pinned image, one bounded task and no retries",()=>{
  expect(validateRecoveryDeployment(d)).toEqual(d);const body=recoveryJobBody(d);
  expect(body).not.toHaveProperty("name"); // Cloud Run CreateJob requires jobId in the URL and rejects a body name.
  expect(body.template.taskCount).toBe(1);expect(body.template.parallelism).toBe(1);expect(body.template.template.maxRetries).toBe(0);expect(body.template.template.timeout).toBe("3600s");
  expect(body.template.template.containers[0].resources.limits).toEqual({cpu:"1",memory:"1Gi"});
  for(const edit of [{image:d.image.replace(/@sha256:.*/,":latest")},{region:"us-central1"},{backupServiceAccount:d.triggerServiceAccount},{project:"other"}])expect(()=>validateRecoveryDeployment({...d,...edit})).toThrow();
});
it("scheduler only invokes its own backup job once per Taipei day without retry",()=>{
  const s=recoverySchedulerBody(d);expect(s.schedule).toBe("30 3 * * *");expect(s.timeZone).toBe("Asia/Taipei");expect(s.retryConfig.retryCount).toBe(0);expect(s.httpTarget.uri).toBe(`https://run.googleapis.com/v2/projects/${project}/locations/asia-east1/jobs/yzt-recovery-backup:run`);expect(s.httpTarget.oauthToken.serviceAccountEmail).toBe(d.triggerServiceAccount);
});
it("IAM changes require an etag and retain unrelated and conditional bindings",()=>{
  const before={etag:"known",version:3,bindings:[{role:"roles/owner",members:["user:existing@example.test"]},{role:"custom/reader",members:["serviceAccount:conditional"],condition:{expression:"true"}}]};
  const after=addExactIamMember(before,"custom/reader","serviceAccount:backup");
  expect(after.bindings.slice(0,2)).toEqual(before.bindings);expect(after.bindings[2]).toEqual({role:"custom/reader",members:["serviceAccount:backup"]});expect(before.bindings).toHaveLength(2);
  expect(addExactIamMember(after,"custom/reader","serviceAccount:backup").bindings).toEqual(after.bindings);
  expect(()=>addExactIamMember({bindings:[]},"roles/owner","serviceAccount:backup")).toThrow();
});
it("backup role permissions never grant source account/data writes or destination deletion",()=>{
  expect(RECOVERY_ROLES.yztRecoverySourceReader).not.toEqual(expect.arrayContaining(["firebaseauth.users.update","datastore.entities.create","datastore.entities.update"]));
  expect(RECOVERY_ROLES.yztRecoverySourceObjects.every(p=>!p.endsWith("create")&&!p.endsWith("delete")&&!p.endsWith("update"))).toBe(true);
  expect(RECOVERY_ROLES.yztRecoveryBackupWriter).toContain("storage.objects.create");expect(RECOVERY_ROLES.yztRecoveryBackupWriter).not.toContain("storage.objects.delete");
});
