import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {validateRecoveryPlan} from "./recovery-core.js";
import {performCompleteBackup} from "./recovery-backup.js";
export * from "./recovery-backup.js";

async function main(){const args=process.argv.slice(2);const value=(name:string)=>{const i=args.indexOf(name);if(i<0||!args[i+1])throw Error("missing_recovery_argument");return args[i+1]};const plan=validateRecoveryPlan(JSON.parse(await fs.readFile(value("--plan"),"utf8")));const result=await performCompleteBackup(plan,path.resolve(value("--receipts")),args.includes("--execute"));console.log(JSON.stringify(result));}
if(import.meta.url===pathToFileURL(process.argv[1]||"").href)main().catch(e=>{console.error(JSON.stringify({status:"failed",code:/^[a-zA-Z0-9_]+$/.test(e.message)?e.message:"recovery_failed_redacted"}));process.exitCode=1;});
