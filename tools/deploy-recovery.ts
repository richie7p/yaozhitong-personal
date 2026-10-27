import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { recoveryClient } from "./recovery-backup.js";
import { addExactIamMember, RECOVERY_ROLES, recoveryJobBody, recoverySchedulerBody, validateRecoveryDeployment, type RecoveryDeployment } from "./recovery-deployment.js";

export async function deployRecovery(d:RecoveryDeployment,receipts:string,execute:boolean){
  validateRecoveryDeployment(d);
  const preview={job:recoveryJobBody(d),scheduler:recoverySchedulerBody(d),roles:RECOVERY_ROLES,existingApplicationChanges:0};
  await fs.mkdir(receipts,{recursive:true});
  if(!execute){await fs.writeFile(path.join(receipts,"recovery-deployment-preview.json"),JSON.stringify(preview,null,2)+"\n",{flag:"wx"});return {status:"preview",cloudCalls:0,cloudWrites:0,...preview};}
  const client=await recoveryClient();
  async function request(url:string,method="GET",data?:unknown):Promise<any>{try{return(await client.request({url,method,data,retry:false,timeout:60000})).data;}catch(e:any){if(method==="GET"&&e.response?.status===404)return null;throw Error("recovery_deployment_http_"+Number(e.response?.status||0));}}
  const source=await request("https://cloudresourcemanager.googleapis.com/v1/projects/"+d.project);if(String(source?.projectNumber)!==d.projectNumber)throw Error("recovery_deployment_project_identity_changed");
  const jobResource=`projects/${d.project}/locations/${d.region}/jobs/${d.job}`;
  const schedulerResource=`projects/${d.project}/locations/${d.region}/jobs/${d.scheduler}`;
  const resources=["https://run.googleapis.com/v2/"+jobResource,"https://cloudscheduler.googleapis.com/v1/"+schedulerResource,...[d.backupServiceAccount,d.triggerServiceAccount].map(a=>`https://iam.googleapis.com/v1/projects/${d.project}/serviceAccounts/${a}`),...Object.keys(RECOVERY_ROLES).map(r=>`https://iam.googleapis.com/v1/projects/${d.project}/roles/${r}`)];
  if((await Promise.all(resources.map(r=>request(r)))).some(Boolean))throw Error("recovery_resources_exist_use_readonly_inspection_no_automatic_overwrite");
  const file=path.join(receipts,"recovery-deployment-journal.json");
  const journal:any={schema:"daily-recovery-deployment/v1",project:d.project,projectNumber:d.projectNumber,image:d.image,at:new Date().toISOString(),status:"intent_frozen",steps:[],sourceAuthWrites:0,sourceObjectWrites:0,sourceFirestoreWrites:0,applicationRuntimeChanges:0,quotaChanges:0};await fs.writeFile(file,JSON.stringify(journal,null,2)+"\n",{flag:"wx"});
  const save=()=>fs.writeFile(file,JSON.stringify(journal,null,2)+"\n");
  async function mutate(label:string,url:string,method:string,data:unknown){const item:any={label,status:"intent_before_single_request",at:new Date().toISOString()};journal.steps.push(item);await save();try{const result=await request(url,method,data);item.status="request_returned";if(result?.name)item.resourceOrOperation=result.name;await save();return result;}catch(error){item.status="stopped_do_not_retry_without_readonly_reconciliation";journal.status="stopped";await save();throw error;}}
  async function waitOperation(operation:any){const deadline=Date.now()+600000;let current=operation;while(!current.done){if(Date.now()>deadline)throw Error("deployment_wait_limit_preserve_operation");await new Promise(r=>setTimeout(r,3000));current=await request("https://run.googleapis.com/v2/"+operation.name);if(!current)throw Error("deployment_operation_missing");}if(current.error)throw Error("deployment_operation_failed_redacted");return current;}
  for(const account of [d.backupServiceAccount,d.triggerServiceAccount])await mutate("create_service_account_"+account.split("@")[0],`https://iam.googleapis.com/v1/projects/${d.project}/serviceAccounts`,"POST",{accountId:account.split("@")[0],serviceAccount:{displayName:account===d.backupServiceAccount?"YZT encrypted recovery backup":"YZT daily recovery trigger",description:"Dedicated recovery operation; no application write privileges"}});
  for(const[id,permissions]of Object.entries(RECOVERY_ROLES))await mutate("create_role_"+id,`https://iam.googleapis.com/v1/projects/${d.project}/roles`,"POST",{roleId:id,role:{title:id,description:"Least privilege for encrypted recovery",stage:"GA",includedPermissions:permissions}});
  const member="serviceAccount:"+d.backupServiceAccount;
  const projectPolicy=await request(`https://cloudresourcemanager.googleapis.com/v1/projects/${d.project}:getIamPolicy`,"POST",{options:{requestedPolicyVersion:3}});
  await mutate("bind_project_readonly_custom_role",`https://cloudresourcemanager.googleapis.com/v1/projects/${d.project}:setIamPolicy`,"POST",{policy:addExactIamMember(projectPolicy,`projects/${d.project}/roles/yztRecoverySourceReader`,member)});
  for(const[bucket,role]of [[d.backupPlan.sourceBucket,"yztRecoverySourceObjects"],[d.backupPlan.backupBucket,"yztRecoveryBackupWriter"]]){const url=`https://storage.googleapis.com/storage/v1/b/${bucket}/iam`;const before=await request(url+"?optionsRequestedPolicyVersion=3");await mutate("bind_bucket_role_"+role,url,"PUT",addExactIamMember(before,`projects/${d.project}/roles/${role}`,member));}
  const secret=d.backupPlan.backupKeyVersion.replace(/\/versions\/\d+$/,"");
  const secretPolicy=await request(`https://secretmanager.googleapis.com/v1/${secret}:getIamPolicy?options.requestedPolicyVersion=3`);
  await mutate("bind_exact_secret_accessor",`https://secretmanager.googleapis.com/v1/${secret}:setIamPolicy`,"POST",{policy:addExactIamMember(secretPolicy,"roles/secretmanager.secretAccessor",member)});
  const createdJob=await mutate("create_bounded_backup_job",`https://run.googleapis.com/v2/projects/${d.project}/locations/${d.region}/jobs?jobId=${d.job}`,"POST",recoveryJobBody(d));await waitOperation(createdJob);
  const jobPolicy=await request(`https://run.googleapis.com/v2/${jobResource}:getIamPolicy?options.requestedPolicyVersion=3`);
  await mutate("bind_own_job_invoker",`https://run.googleapis.com/v2/${jobResource}:setIamPolicy`,"POST",{policy:addExactIamMember(jobPolicy,"roles/run.invoker","serviceAccount:"+d.triggerServiceAccount)});
  await mutate("create_daily_scheduler",`https://cloudscheduler.googleapis.com/v1/projects/${d.project}/locations/${d.region}/jobs`,"POST",recoverySchedulerBody(d));
  const [job,scheduler]=await Promise.all([request("https://run.googleapis.com/v2/"+jobResource),request("https://cloudscheduler.googleapis.com/v1/"+schedulerResource)]);
  if(job?.template?.template?.containers?.[0]?.image!==d.image||job?.template?.taskCount!==1||(job?.template?.template?.maxRetries??0)!==0||scheduler?.schedule!=="30 3 * * *"||scheduler?.timeZone!=="Asia/Taipei"||scheduler?.state!=="ENABLED")throw Error("daily_recovery_configuration_readback_failed");
  journal.status="daily_job_and_scheduler_created_verified";journal.completedAt=new Date().toISOString();await save();return{status:journal.status,job:jobResource,scheduler:schedulerResource,image:d.image,sourceAuthWrites:0,sourceObjectWrites:0,sourceFirestoreWrites:0,quotaChanges:0};
}
async function main(){const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error("missing_recovery_deployment_argument");return args[i+1]};const d=validateRecoveryDeployment(JSON.parse(await fs.readFile(value("--plan"),"utf8")));console.log(JSON.stringify(await deployRecovery(d,path.resolve(value("--receipts")),args.includes("--execute"))));}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href)main().catch(e=>{console.error(JSON.stringify({status:"failed",code:/^[a-zA-Z0-9_]+$/.test(e.message)?e.message:"deployment_failed_redacted"}));process.exitCode=1;});
