import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { HTML_RECTANGULAR_OUTLINE_SERIALIZATION, validateHtmlNumberedOutlineReport, validateHtmlRectangularOutlineReport, verifyCandidateFromRaw } from "../tools/tfda-candidate-verification.js";
import { publicationHash } from "../tools/tfda-publication-core.js";
import { evaluateTfdaSource, type TfdaSourceInput } from "../tools/tfda-source-core.js";
const runFile = promisify(execFile), python = process.env.TFDA_TEST_PYTHON || "python";
const license="衛署藥製字第012345號", nameZh="合成矩形表測試錠", nameEn="SYNTHETIC RECTANGULAR TABLE TEST", url="https://mcp.fda.gov.tw/exportpdf/"+license;
const body="本段是合成測試資料，並非真實藥品資訊。每一項文字及表格行欄必須按照原始來源完整保留，不得新增醫療建議。".repeat(4);
const raw=Buffer.from(`<html><body><div class="page_name"><label>中文品名</label><span>${nameZh}</span></div><div class="page_name"><label>英文品名</label><span>${nameEn}</span></div><div class="page_name"><label>許可證號</label><span>${license}</span></div><div class="page_name"><label>藥品類別</label><span>合成處方藥</span></div><div class="toggle-all"><div class="toggle"><div class="toggle-title"><span class="title-name">5 警語及注意事項</span></div><div class="toggle-inner"><table><tr><td>5.1</td><td>${body}</td></tr><tr><td></td><td><table><tbody></tbody></table><figure class="table"><table><tr><th>年齡</th><th>單次用量</th><th>頻次</th></tr><tr><td>成人</td><td>10 mg</td><td>每日一次</td></tr><tr><td>兒童</td><td>不得使用</td><td>不得使用</td></tr></table></figure></td></tr></table></div></div></div></body></html>`);
let folder:string, rawPath:string, report:any, input:TfdaSourceInput;
async function inspect(bytes:Buffer) {
 const path=join(folder,randomUUID()+".html");await writeFile(path,bytes);
 const result=await runFile(python,["-X","utf8",resolve("tools/fetch-tfda-sources.py"),"--inspect-html-outline-rectangular-internal",path,url],{windowsHide:true,encoding:"utf8",maxBuffer:2000000});
 return {path,report:JSON.parse(result.stdout.trim())};
}
const literal=(r:any)=>r.numberedOutlineEvidence.roots[0].table.rows[1].rightPieces.find((p:any)=>p.kind==="literal_table").table;
const empty=(r:any)=>r.numberedOutlineEvidence.roots[0].table.rows[1].rightPieces.find((p:any)=>p.kind==="literal_empty_table").table;
beforeAll(async()=>{
 folder=await mkdtemp(join(tmpdir(),"tfda-rectangular-test-"));const actual=await inspect(raw);rawPath=actual.path;report=actual.report;
 const text=[nameZh,nameEn,license,"合成處方藥"].join("\n")+"\n\n"+report.normalizedSectionText, now=new Date().toISOString();
 input={licenseNo:license,officialCategory:"合成處方藥",checkedAt:now,catalogCheckedAt:now,indexCheckedAt:now,catalogRows:[{licenseNo:license,nameZh,nameEn,form:"合成錠劑",manufacturer:"合成製造商",effectiveUntil:"2035/12/31",revoked:false}],indexRows:[{licenseNo:license,nameZh,nameEn,urls:[url]}],fetched:{requestedUrl:url,finalUrl:url,redirectChain:[url],retrievedAt:now,sha256:publicationHash(raw),bytes:raw.length,mediaType:"text/html",contentSignature:"html"},format:"html",numPages:1,pages:[{page:1,text,embeddedImages:0,hasLargeUnverifiedImage:false}],htmlEvidence:{completeMainDocument:true,domConservationPassed:true,canonicalTextSha256:publicationHash(text),sectionCount:1,hasUnverifiedNonTextContent:false,tableSerializationVersion:HTML_RECTANGULAR_OUTLINE_SERIALIZATION as any,numberedOutlineEvidenceSha256:publicationHash(JSON.stringify(report.numberedOutlineEvidence))}};
});
afterAll(async()=>{if(folder){expect(resolve(folder).startsWith(resolve(tmpdir())+sep)).toBe(true);await rm(folder,{recursive:true,force:true});}});
describe("explicit literal rectangular subtable raw evidence",()=>{
 it("reparses real bytes and retains every literal row/cell/header without numbered interpretation",async()=>{
  expect(evaluateTfdaSource(input).eligibleTechnical).toBe(true);expect(validateHtmlRectangularOutlineReport(report)).toEqual(report.numberedOutlineEvidence);
  const proof=await verifyCandidateFromRaw(rawPath,raw,input,{python});expect(proof.method).toBe("html_raw_rectangular_outline_reparse_v2");expect(proof.htmlNumberedOutlineEvidence).toEqual(report.numberedOutlineEvidence);
  expect(literal(report).rows[0].map((x:any)=>x.tag)).toEqual(["th","th","th"]);expect(input.pages[0].text).toContain("成人\t10 mg\t每日一次");
 });
 it("cannot use v1 marker or validator to authorize v2 grids",async()=>{
  expect(()=>validateHtmlNumberedOutlineReport(report)).toThrow();const changed=structuredClone(input);changed.htmlEvidence!.tableSerializationVersion="tfda-numbered-outline-literal-v1";
  await expect(verifyCandidateFromRaw(rawPath,raw,changed,{python})).rejects.toThrow();
 });
 it.each(["literalTableCount","literalTableIndices"])("rejects fabricated %s",(key)=>{
  const x=structuredClone(report);x.numberedOutlineEvidence[key]=key==="literalTableCount"?x.numberedOutlineEvidence.literalTableCount+1:[1,1];expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();
 });
 it("rejects changed cells, missing columns or reordered rows",()=>{
  for(const change of [(x:any)=>literal(x).rows[1][1].text="100 mg",(x:any)=>literal(x).rows[1].pop(),(x:any)=>literal(x).rows.reverse()]){const x=structuredClone(report);change(x);expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();}
 });
 it("rejects fake simple-table flags and missing native cell inventory",()=>{
  const x=structuredClone(report);x.sections[0].tables[2].simple=false;expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();
  const y=structuredClone(report);delete literal(y).cellTagInventory;expect(()=>validateHtmlRectangularOutlineReport(y)).toThrow();
 });
 it("rejects spans, unknown nested tags and wrapper changes",()=>{
  for(const change of [(x:any)=>literal(x).rows[0][0].colspan="2",(x:any)=>literal(x).cellTagInventory[0][0].push("img"),(x:any)=>literal(x).wrapper.otherContent=true,(x:any)=>literal(x).wrapper.attrs.style="order:2;"]){const x=structuredClone(report);change(x);expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();}
 });
 it("retains zero-text empty layout inventory and rejects hidden content claims",()=>{
  expect(empty(report).rows).toEqual([]);expect(empty(report).nodeTagInventory).toEqual(["table","tbody"]);
  for(const change of [(x:any)=>empty(x).nodeTagInventory.push("script"),(x:any)=>empty(x).serializedText="不可略過正文",(x:any)=>empty(x).tableIndex=2]){const x=structuredClone(report);change(x);expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();}
 });
 it("cannot relabel a literal dose grid as a numbered child",()=>{
  const x=structuredClone(report);x.numberedOutlineEvidence.roots[0].table.rows[1].rightPieces[0].kind="table";expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();
 });
 it("binds candidate proof hash and cell text to the actual source",async()=>{
  const x=structuredClone(input);x.htmlEvidence!.numberedOutlineEvidenceSha256="f".repeat(64);await expect(verifyCandidateFromRaw(rawPath,raw,x,{python})).rejects.toThrow("candidate_html_evidence_does_not_match_raw_source");
  const changedRaw=Buffer.from(raw.toString().replace("10 mg","100 mg")), changed=await inspect(changedRaw), y=structuredClone(input);y.fetched.sha256=publicationHash(changedRaw);y.fetched.bytes=changedRaw.length;
  await expect(verifyCandidateFromRaw(changed.path,changedRaw,y,{python})).rejects.toThrow("candidate_html_pages_do_not_match_raw_source");
 });
 it("continues to reject excessive proof size and unknown markers",async()=>{
  const x=structuredClone(report);literal(x).unchecked="x".repeat(100001);expect(()=>validateHtmlRectangularOutlineReport(x)).toThrow();
  const y=structuredClone(input);(y.htmlEvidence as any).tableSerializationVersion="unchecked-rectangles";await expect(verifyCandidateFromRaw(rawPath,raw,y,{python:"missing-must-not-run"})).rejects.toThrow("candidate_html_outline_marker_invalid");
 });
 it.each(["<img src='warning.png' alt=''>","<ul><li>條件</li></ul>"])("cannot erase unsupported source content %s",async(node)=>{
  const bytes=Buffer.from(raw.toString().replace("10 mg","10 mg"+node)), actual=await inspect(bytes), changed=structuredClone(input);changed.fetched.sha256=publicationHash(bytes);changed.fetched.bytes=bytes.length;
  await expect(verifyCandidateFromRaw(actual.path,bytes,changed,{python})).rejects.toThrow();
 });
});
