import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptRecovery, decryptRecovery, validateRecoveryPlan, assertPrivateBucket, assertRestoreTarget, confirmedUploadOwner, objectIdentity, quarantineMetadata, objectRestoreDecision, prepareQuarantinedAuthImport, stableJson, uploadRetentionTimes, authCriticalProjection } from "../tools/recovery-core.js";

const plan = {schema:"yzt-complete-backup-plan/v1",sourceProject:"example-source",sourceProjectNumber:"123456",sourceBucket:"private-source",backupBucket:"private-backup",backupKeyVersion:"projects/example-source/secrets/key/versions/1",maxObjects:4000,maxBytes:600*1024*1024,maxAuthUsers:100,retentionDays:7,concurrency:4};
describe("complete recovery boundaries", () => {
  it("AEAD recovers exact binary and rejects modified bytes, key, identity and truncated envelopes", () => {
    const key=randomBytes(32), plain=Buffer.concat([Buffer.from([0,255,12]),randomBytes(400)]);
    const sealed=encryptRecovery(plain,key,"blob/source-generation");
    expect(decryptRecovery(sealed,key,"blob/source-generation")).toEqual(plain);
    expect(sealed.includes(plain)).toBe(false);
    for(const index of [8,20,36,sealed.length-1]){const changed=Buffer.from(sealed);changed[index]^=1;expect(()=>decryptRecovery(changed,key,"blob/source-generation")).toThrow();}
    expect(()=>decryptRecovery(sealed,randomBytes(32),"blob/source-generation")).toThrow();
    expect(()=>decryptRecovery(sealed,key,"blob/other-generation")).toThrow();
    expect(()=>decryptRecovery(sealed.subarray(0,20),key,"blob/source-generation")).toThrow();
    expect(encryptRecovery(plain,key,"blob/source-generation")).not.toEqual(sealed);
  });
  it("pins different buckets, immutable key version and bounded costs", () => {
    expect(validateRecoveryPlan(plan).maxObjects).toBe(4000);
    for (const edit of [{backupBucket:plan.sourceBucket},{backupKeyVersion:plan.backupKeyVersion.replace("/1","/latest")},{maxObjects:0},{maxBytes:Infinity},{concurrency:40},{retentionDays:365}]) expect(()=>validateRecoveryPlan({...plan,...edit})).toThrow();
  });
  it("requires exact private bucket and created isolated project identity", () => {
    const bucket={name:"private-backup",projectNumber:"123456",iamConfiguration:{uniformBucketLevelAccess:{enabled:true},publicAccessPrevention:"enforced"}};
    expect(()=>assertPrivateBucket(bucket,"private-backup","123456")).not.toThrow();
    for(const changed of [{...bucket,name:"other"},{...bucket,projectNumber:"999"},{...bucket,iamConfiguration:{}}]) expect(()=>assertPrivateBucket(changed,"private-backup","123456")).toThrow();
    const project={projectId:"yzt-dr-20261023-aabbcc",projectNumber:"999",lifecycleState:"ACTIVE"};
    expect(()=>assertRestoreTarget("example-source",project.projectId,"999",project)).not.toThrow();
    expect(()=>assertRestoreTarget("example-source","example-source","999",project)).toThrow();
    expect(()=>assertRestoreTarget("example-source",project.projectId,"998",project)).toThrow();
  });
  it("restores safe file metadata without turning download tokens or public cache into access", () => {
    const raw={contentType:"image/png",cacheControl:"public,max-age=31536000",metadata:{ownerId:"owner",firebaseStorageDownloadTokens:"secret-token",authorization:"secret",note:"retain"},acl:[{entity:"allUsers",role:"READER"}],generation:"44"};
    expect(quarantineMetadata(raw)).toEqual({contentType:"image/png",cacheControl:"private, no-store, max-age=0",metadata:{ownerId:"owner",note:"retain"}});
    expect(raw.metadata.firebaseStorageDownloadTokens).toBe("secret-token");
  });
  it("does not restore expired, deleted-owner or unknown-owner uploads", () => {
    const object:any={name:"uploads/opaque.png",ownerId:"owner",expiresAt:"2026-10-24T00:00:00Z"};
    const now=new Date("2026-10-23T00:00:00Z");
    expect(objectRestoreDecision(object,new Set(),now)).toBe("restore");
    expect(objectRestoreDecision(object,new Set(["owner"]),now)).toBe("quarantined_owner");
    expect(objectRestoreDecision({...object,expiresAt:"2026-10-22T00:00:00Z"},new Set(),now)).toBe("expired");
    expect(objectRestoreDecision({...object,ownerId:undefined},new Set(),now)).toBe("unresolved_upload_owner");
    expect(objectRestoreDecision({...object,expiresAt:"bad"},new Set(),now)).toBe("expired");
  });
  it("requires a known account or tombstone as well as the server upload path",()=>{
    const owners=new Set(["known"]);
    expect(confirmedUploadOwner("uploads/known/image",undefined,owners)).toBe("known");
    expect(confirmedUploadOwner("uploads/unknown/image",undefined,owners)).toBeUndefined();
    expect(confirmedUploadOwner("uploads/known/image","other",owners)).toBeUndefined();
    expect(confirmedUploadOwner("uploads/known/sub/image",undefined,owners)).toBeUndefined();
    expect(()=>validateRecoveryPlan({...plan,maxObjectBytes:1024*1024*1024})).toThrow();
  });
  it("backup cannot extend upload retention by resetting its creation date",()=>{
    expect(uploadRetentionTimes({timeCreated:"2026-10-23T00:00:00Z"})).toEqual({customTime:"2026-10-23T00:00:00.000Z",expiresAt:"2026-10-24T00:00:00.000Z"});
    expect(uploadRetentionTimes({timeCreated:"2026-10-23T00:00:00Z",customTime:"2026-10-22T00:00:00Z"}).expiresAt).toBe("2026-10-23T00:00:00.000Z");
    expect(uploadRetentionTimes({timeCreated:"2026-10-23T00:00:00Z",customTime:"2026-10-29T00:00:00Z"}).expiresAt).toBe("2026-10-24T00:00:00.000Z");
    expect(()=>uploadRetentionTimes({})).toThrow();
  });
  it("preserves scrypt, OAuth and claims while quarantining all users and excluding newer tombstones", () => {
    const users=[{localId:"password",email:"synthetic@example.test",emailVerified:true,passwordHash:"hash",salt:"salt",disabled:false,customAttributes:'{"admin":true}',providerUserInfo:[{providerId:"password",rawId:"synthetic@example.test"}]},{localId:"google",disabled:true,providerUserInfo:[{providerId:"google.com",rawId:"provider-id"}]},{localId:"deleted",disabled:false}];
    const hash={algorithm:"SCRYPT",signerKey:"key",saltSeparator:"salt",rounds:8,memoryCost:14};
    const imported=prepareQuarantinedAuthImport(users,hash,new Set(["password","google","deleted"]),new Set(["deleted"]));
    expect(imported.allowOverwrite).toBe(false);expect(imported.sanityCheck).toBe(true);
    expect(imported.users).toHaveLength(2);expect(imported.users.every(x=>x.disabled)).toBe(true);
    expect(imported.users[0].passwordHash).toBe("hash");expect(imported.users[0].customAttributes).toBe(users[0].customAttributes);
    expect(imported.users[0].providerUserInfo).toEqual([]);
    expect(imported.users[1].providerUserInfo).toEqual(users[1].providerUserInfo);
    expect(()=>prepareQuarantinedAuthImport([...users,users[0]],hash,new Set(),new Set())).toThrow();
    expect(()=>prepareQuarantinedAuthImport([{...users[0],passwordHash:""}],hash,new Set(["password"]),new Set())).toThrow();
    expect(()=>prepareQuarantinedAuthImport(users,{...hash,signerKey:""},new Set(),new Set())).toThrow();
    expect(()=>prepareQuarantinedAuthImport([{localId:"mfa",mfaInfo:[{}]}],hash,new Set(["mfa"]),new Set())).toThrow();
  });
  it("source consistency checks ignore routine sign-in telemetry but retain credential and deletion changes", () => {
    const a={localId:"owner",passwordHash:"hash",validSince:"42",lastLoginAt:"one"};
    expect(stableJson(authCriticalProjection({...a,lastLoginAt:"two"}))).toBe(stableJson(authCriticalProjection(a)));
    expect(stableJson(authCriticalProjection({...a,passwordHash:"new"}))).not.toBe(stableJson(authCriticalProjection(a)));
    expect(stableJson(authCriticalProjection({...a,disabled:true}))).not.toBe(stableJson(authCriticalProjection(a)));
    expect(()=>objectIdentity({name:"x",generation:"1e5",metageneration:"1",size:1})).toThrow();
    expect(objectIdentity({name:"x",generation:"123",metageneration:"1",size:"2"})).toEqual({name:"x",generation:"123",metageneration:"1",size:2});
  });
});
