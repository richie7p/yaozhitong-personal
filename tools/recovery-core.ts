import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const RECOVERY_MAGIC = Buffer.from("YZTBK001");
export const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k,v]) => JSON.stringify(k) + ":" + stableJson(v)).join(",") + "}";
  return JSON.stringify(value);
}
export function encryptRecovery(plain: Buffer, key: Buffer, context: string): Buffer {
  if (key.length !== 32 || !context) throw Error("invalid_recovery_encryption_parameters");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([RECOVERY_MAGIC, iv, cipher.getAuthTag(), body]);
}
export function decryptRecovery(envelope: Buffer, key: Buffer, context: string): Buffer {
  if (key.length !== 32 || !context || envelope.length < 36 || !envelope.subarray(0,8).equals(RECOVERY_MAGIC)) throw Error("invalid_recovery_envelope");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(8,20));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(envelope.subarray(20,36));
    return Buffer.concat([decipher.update(envelope.subarray(36)), decipher.final()]);
  } catch { throw Error("recovery_authentication_failed"); }
}
export interface RecoveryPlan {
  schema: "yzt-complete-backup-plan/v1";
  sourceProject: string;
  sourceProjectNumber: string;
  sourceBucket: string;
  backupBucket: string;
  backupKeyVersion: string;
  maxObjects: number;
  maxBytes: number;
  maxAuthUsers: number;
  maxObjectBytes?: number;
  retentionDays: number;
  concurrency: number;
}
export function validateRecoveryPlan(value: unknown): RecoveryPlan {
  const p = value as RecoveryPlan;
  if (!p || p.schema !== "yzt-complete-backup-plan/v1" || !/^[a-z][a-z0-9-]{4,62}$/.test(p.sourceProject) || !/^\d+$/.test(p.sourceProjectNumber) || !/^[a-z0-9][a-z0-9.-]{2,221}$/.test(p.sourceBucket) || !/^[a-z0-9][a-z0-9.-]{2,221}$/.test(p.backupBucket) || p.sourceBucket === p.backupBucket) throw Error("invalid_recovery_plan_resources");
  if (!new RegExp("^projects/" + p.sourceProject + "/secrets/[a-zA-Z0-9_-]+/versions/[1-9][0-9]*$").test(p.backupKeyVersion)) throw Error("recovery_key_must_pin_immutable_version");
  for (const [v, max] of [[p.maxObjects, 100000], [p.maxBytes, 10737418240], [p.maxAuthUsers, 100000], [p.retentionDays, 30], [p.concurrency, 8]]) if (!Number.isSafeInteger(v) || v < 1 || v > max) throw Error("invalid_recovery_plan_limits");
  if(p.maxObjectBytes!==undefined&&(!Number.isSafeInteger(p.maxObjectBytes)||p.maxObjectBytes<1||p.maxObjectBytes>134217728))throw Error("invalid_recovery_object_memory_bound");
  return p;
}
export function assertPrivateBucket(metadata: any, expectedName: string, expectedProjectNumber: string) {
  if (metadata.name !== expectedName || String(metadata.projectNumber) !== expectedProjectNumber || !metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled || metadata.iamConfiguration?.publicAccessPrevention !== "enforced") throw Error("recovery_bucket_identity_or_privacy_failed");
}
export function assertRestoreTarget(source: string, target: string, createdProjectNumber: string, observed: any) {
  if (target === source || !/^yzt-dr-\d{8}-[a-f0-9]{6,12}$/.test(target) || observed.projectId !== target || String(observed.projectNumber) !== createdProjectNumber || observed.lifecycleState !== "ACTIVE") throw Error("restore_target_not_exact_created_isolated_project");
}
export interface RecoveryObject {
  name: string;
  generation: string;
  metageneration: string;
  size: number;
  metadata: Record<string, any>;
  plaintextSha256: string | null;
  ciphertextSha256: string | null;
  backupObject: string | null;
  backupGeneration: string | null;
  backupDisposition?: "encrypted" | "expired_not_copied";
  ownerId?: string;
  expiresAt?: string;
}
export function objectIdentity(metadata: any) {
  if (!metadata || typeof metadata.name !== "string" || !/^\d+$/.test(metadata.generation) || !/^\d+$/.test(metadata.metageneration) || !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) < 0) throw Error("invalid_source_object_identity");
  return {name: metadata.name, generation: metadata.generation, metageneration: metadata.metageneration, size: Number(metadata.size)};
}
export function quarantineMetadata(original: Record<string, any>) {
  const out: Record<string, any> = { cacheControl: "private, no-store, max-age=0" };
  for (const key of ["contentType", "contentDisposition", "contentEncoding", "contentLanguage"]) if (typeof original[key] === "string") out[key] = original[key];
  const custom = {...original.metadata};
  for (const key of Object.keys(custom)) if (/token|secret|credential|authorization|cookie/i.test(key)) delete custom[key];
  if (Object.keys(custom).length) out.metadata = custom;
  return out;
}
export function objectRestoreDecision(object: RecoveryObject, deletedOrDisabledOwners: Set<string>, now: Date) {
  if (object.ownerId && deletedOrDisabledOwners.has(object.ownerId)) return "quarantined_owner";
  if (object.expiresAt && (!Number.isFinite(Date.parse(object.expiresAt)) || Date.parse(object.expiresAt) <= now.getTime())) return "expired";
  if (object.name.startsWith("uploads/") && !object.ownerId) return "unresolved_upload_owner";
  return "restore";
}
export function confirmedUploadOwner(name:string,metadataOwner:unknown,knownOwners:Set<string>){
  if(!name.startsWith("uploads/"))return undefined;
  const match=/^uploads\/([^/]+)\/[^/]+$/.exec(name);
  if(!match||!knownOwners.has(match[1])||(metadataOwner!==undefined&&metadataOwner!==match[1]))return undefined;
  return match[1];
}
export function uploadRetentionTimes(metadata:Record<string,unknown>){
  const created=Date.parse(String(metadata.timeCreated||""));
  if(!Number.isFinite(created))throw Error("upload_creation_time_required");
  const custom=Date.parse(String(metadata.customTime||""));
  const basis=Number.isFinite(custom)?Math.min(created,custom):created;
  return {customTime:new Date(basis).toISOString(),expiresAt:new Date(basis+86400000).toISOString()};
}
export function authCriticalProjection(user: any): Record<string, any> {
  const keys = ["localId", "email", "emailVerified", "displayName", "photoUrl", "disabled", "passwordHash", "salt", "validSince", "customAttributes", "providerUserInfo", "createdAt", "mfaInfo", "tenantId"];
  return Object.fromEntries(keys.filter(k => user[k] !== undefined).map(k => [k, user[k]]));
}
export interface RecoveryAuthProvider {providerId:string;rawId?:string;email?:string;displayName?:string;photoUrl?:string;}
export interface QuarantinedAuthRecord extends Record<string,unknown> {localId:string;disabled:true;providerUserInfo:RecoveryAuthProvider[];email?:string;emailVerified?:boolean;passwordHash?:string;salt?:string;customAttributes?:string;}
export function comparableAuthProviders(user:any):RecoveryAuthProvider[]{
  return (user.providerUserInfo||[]).map((p:any)=>{if(typeof p.providerId!=="string"||!p.providerId)throw Error("invalid_auth_provider_identity");const out:RecoveryAuthProvider={providerId:p.providerId};for(const k of ["rawId","email","displayName","photoUrl"] as const)if(typeof p[k]==="string"&&p[k]!=="")out[k]=p[k];return out;}).sort((a:RecoveryAuthProvider,b:RecoveryAuthProvider)=>a.providerId.localeCompare(b.providerId,"en"));
}
export function prepareQuarantinedAuthImport(users: any[], hashConfig: any, currentAllowedUids: Set<string>, deletedUids: Set<string>) {
  if (hashConfig?.algorithm !== "SCRYPT" || !hashConfig.signerKey || !hashConfig.saltSeparator || !Number.isInteger(hashConfig.rounds) || !Number.isInteger(hashConfig.memoryCost)) throw Error("complete_scrypt_parameters_required");
  const seen = new Set<string>();
  const selected: QuarantinedAuthRecord[] = [];
  for (const user of users) {
    if (typeof user.localId!=="string"||!user.localId||user.localId.length>128||seen.has(user.localId)) throw Error("duplicate_or_missing_auth_uid");
    seen.add(user.localId);
    if (!currentAllowedUids.has(user.localId) || deletedUids.has(user.localId)) continue;
    if ((user.providerUserInfo || []).some((p: any) => p.providerId === "password") && (!user.passwordHash || !user.salt)) throw Error("password_hash_or_salt_missing");
    if (user.mfaInfo?.length || user.tenantId) throw Error("unsupported_mfa_or_tenant_requires_separate_recovery");
    const record:QuarantinedAuthRecord={...authCriticalProjection(user),localId:user.localId,disabled:true,providerUserInfo:comparableAuthProviders(user).filter(p=>p.providerId!=="password")};
    // The export includes a synthetic password provider. The import endpoint accepts
    // federated providers only; email/hash/salt rebuild the password provider.
    for(const field of ["passwordHash","salt"] as const)if(record[field])record[field]=record[field].replace(/\+/g,"-").replace(/\//g,"_");
    selected.push(record);
  }
  return {hashAlgorithm: hashConfig.algorithm, signerKey: hashConfig.signerKey.replace(/\+/g,"-").replace(/\//g,"_"), saltSeparator: hashConfig.saltSeparator.replace(/\+/g,"-").replace(/\//g,"_"), rounds: hashConfig.rounds, memoryCost: hashConfig.memoryCost, users: selected, sanityCheck: true, allowOverwrite: false};
}
