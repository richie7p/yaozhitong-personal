import { validateRecoveryPlan, type RecoveryPlan } from "./recovery-core.js";

export interface RecoveryDeployment {
  project: string;
  projectNumber: string;
  region: string;
  job: string;
  scheduler: string;
  backupServiceAccount: string;
  triggerServiceAccount: string;
  image: string;
  backupPlan: RecoveryPlan;
}
export const RECOVERY_ROLES = {
  yztRecoverySourceReader: ["firebaseauth.users.get", "firebaseauth.configs.get", "firebaseauth.configs.getHashConfig", "datastore.entities.get", "datastore.entities.list", "resourcemanager.projects.get"],
  yztRecoverySourceObjects: ["storage.buckets.get", "storage.buckets.getIamPolicy", "storage.objects.get", "storage.objects.list"],
  yztRecoveryBackupWriter: ["storage.buckets.get", "storage.objects.create", "storage.objects.get", "storage.objects.list"],
} as const;
export function validateRecoveryDeployment(value:unknown):RecoveryDeployment {
  const d=value as RecoveryDeployment;
  if(!d||d.project!==d.backupPlan?.sourceProject||d.projectNumber!==d.backupPlan?.sourceProjectNumber||!/^asia-east1$/.test(d.region)||d.job!=="yzt-recovery-backup"||d.scheduler!=="yzt-recovery-daily"||d.backupServiceAccount!==`yzt-recovery-backup@${d.project}.iam.gserviceaccount.com`||d.triggerServiceAccount!==`yzt-recovery-trigger@${d.project}.iam.gserviceaccount.com`||!new RegExp(`^${d.region}-docker\\.pkg\\.dev/${d.project}/yaozhitong/recovery@sha256:[a-f0-9]{64}$`).test(d.image))throw Error("invalid_recovery_deployment_resources");
  validateRecoveryPlan(d.backupPlan);return d;
}
export function recoveryJobBody(d:RecoveryDeployment) {
  validateRecoveryDeployment(d);
  return {labels:{application:"yaozhitong",purpose:"daily-backup"},template:{taskCount:1,parallelism:1,template:{serviceAccount:d.backupServiceAccount,timeout:"3600s",maxRetries:0,containers:[{name:"backup",image:d.image,env:[{name:"RECOVERY_PLAN_JSON",value:JSON.stringify(d.backupPlan)}],resources:{limits:{cpu:"1",memory:"1Gi"}}}]}}};
}
export function recoverySchedulerBody(d:RecoveryDeployment){
  validateRecoveryDeployment(d);
  return {name:`projects/${d.project}/locations/${d.region}/jobs/${d.scheduler}`,description:"One encrypted Auth and object backup daily; no application write permissions",schedule:"30 3 * * *",timeZone:"Asia/Taipei",attemptDeadline:"180s",retryConfig:{retryCount:0},httpTarget:{uri:`https://run.googleapis.com/v2/projects/${d.project}/locations/${d.region}/jobs/${d.job}:run`,httpMethod:"POST",headers:{"Content-Type":"application/json"},body:Buffer.from("{}").toString("base64"),oauthToken:{serviceAccountEmail:d.triggerServiceAccount,scope:"https://www.googleapis.com/auth/cloud-platform"}}};
}
export function addExactIamMember(policy:any,role:string,member:string){
  if(!policy?.etag||!member.startsWith("serviceAccount:"))throw Error("iam_etag_and_exact_service_account_required");
  const clone=structuredClone(policy);clone.version=Math.max(3,clone.version||0);clone.bindings ||= [];
  const binding=clone.bindings.find((b:any)=>b.role===role&&!b.condition);
  if(binding){binding.members ||= [];if(!binding.members.includes(member))binding.members.push(member);}else clone.bindings.push({role,members:[member]});
  return clone;
}
