#!/usr/bin/env python3
"""Bounded native Safari synthetic-file investigation, isolated from the main PR.

Uses the committed V3 standard-library WebDriver helper. Six native selections:
four application cases (workspace/tmp x closed before/after session), followed by
two about:blank controls reusing the pre-session files. No File/DataTransfer
fallback, recognition, medication save, real provider or health file is used.
"""
from __future__ import annotations
import argparse, base64, datetime as dt, hashlib, importlib.util, json, os
from pathlib import Path
import platform, re, struct, subprocess, sys, tempfile, time, zlib

APP_BASE = "7ffee6529b1a463ded6d229b8f45771de22af52f"
HELPER_SHA = "b41893b26895e6c64febb89e0876261a611f19c90ffc81e5b0104faf384f0852"
QA_PATHS = {".github/workflows/desktop-browsers.yml", "tools/check-safari-file-fixture.py"}
REPLACED_WORKFLOW = ".github/workflows/desktop-browsers.yml"
CASE_IDS = ["app-workspace-before", "app-tmp-before", "app-workspace-after",
            "app-tmp-after", "blank-workspace-before", "blank-tmp-before"]
HEADER = [137, 80, 78, 71, 13, 10, 26, 10]

CAPTURE_JS = """
const input=arguments[0],native=arguments[1];
window.__yztFileFixture={file:null,changes:0};
input.addEventListener('change',()=>{
 const state=window.__yztFileFixture;state.file=input.files&&input.files[0]||null;state.changes++;
 if(native&&state.file)document.getElementById('native-preview').src=URL.createObjectURL(state.file);
},{capture:true,once:true});
"""
READ_JS = """
const done=arguments[arguments.length-1],state=window.__yztFileFixture||{},file=state.file;
const metadata=file?{name:file.name,type:file.type,size:file.size,lastModified:file.lastModified}:null;
if(!file){done({filePresent:false,changes:state.changes||0,metadata,
 arrayBuffer:{ok:false,error:'no-captured-file'},fileReader:{ok:false,error:'no-captured-file'}});return;}
const errorData=e=>({ok:false,errorName:String(e&&e.name||'Error'),errorMessage:String(e&&e.message||e||'unknown').slice(0,250)});
const arrayBuffer=()=>new Promise(resolve=>{
 let ended=false;const finish=x=>{if(!ended){ended=true;clearTimeout(timer);resolve(x);}};
 const timer=setTimeout(()=>finish({ok:false,errorName:'ProbeTimeout',errorMessage:'8-byte arrayBuffer read timed out'}),8000);
 Promise.resolve().then(()=>file.slice(0,8).arrayBuffer()).then(b=>finish({ok:true,header:Array.from(new Uint8Array(b))}),e=>finish(errorData(e)));
});
const fileReader=()=>new Promise(resolve=>{
 let ended=false;const reader=new FileReader();
 const finish=x=>{if(!ended){ended=true;clearTimeout(timer);resolve(x);}};
 const timer=setTimeout(()=>{finish({ok:false,errorName:'ProbeTimeout',errorMessage:'8-byte FileReader read timed out'});try{reader.abort();}catch{}},8000);
 reader.onload=()=>finish({ok:true,header:Array.from(new Uint8Array(reader.result))});
 reader.onerror=()=>finish(errorData(reader.error));
 reader.onabort=()=>finish({ok:false,errorName:'AbortError',errorMessage:'FileReader aborted'});
 try{reader.readAsArrayBuffer(file.slice(0,8));}catch(e){finish(errorData(e));}
});
(async()=>{const ab=await arrayBuffer(),fr=await fileReader();done({
 filePresent:true,changes:state.changes,metadata,sameCapturedFile:true,
 apiOrder:'arrayBuffer-then-FileReader',bytesPerApi:8,arrayBuffer:ab,fileReader:fr
});})();
"""
UI_JS = """
const native=arguments[0],image=document.querySelector(native?'#native-preview':'.capture-preview img');
let controlled=false,swAccess='available';
try{controlled=!!navigator.serviceWorker?.controller;}catch{swAccess='opaque-origin';}
return {url:location.href,isAboutBlank:location.href==='about:blank',
 appRootPresent:!!document.getElementById('root'),serviceWorkerControlled:controlled,swAccess,
 preview:!!image&&image.complete&&image.naturalWidth>0,
 previewWidth:image?.naturalWidth||0,previewHeight:image?.naturalHeight||0,
 alerts:Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.innerText).filter(Boolean)};
"""

def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(repo, *args, data=None):
    return subprocess.check_output(["git", *args], cwd=repo, input=data)

def blobs(repo, refs):
    raw=git(repo, "cat-file", "--batch", data=("".join(r+"\n" for r in refs)).encode())
    offset=0; values=[]
    for _ in refs:
        end=raw.index(b"\n",offset); header=raw[offset:end].decode().split()
        if len(header)!=3 or header[1]!="blob":raise AssertionError("Expected committed blob")
        size=int(header[2]);offset=end+1;values.append(raw[offset:offset+size]);offset+=size+1
    if offset!=len(raw):raise AssertionError("Unexpected git batch output")
    return values

def audit_source(repo, probe_sha):
    actual=git(repo,"rev-parse","HEAD").decode().strip()
    parent=git(repo,"rev-parse","HEAD^").decode().strip()
    if actual!=probe_sha or parent!=APP_BASE:raise AssertionError("Probe HEAD/parent binding failed")
    names=set(git(repo,"diff","--name-only",APP_BASE,actual).decode().splitlines())
    if names!=QA_PATHS:raise AssertionError("Probe branch must replace only its QA workflow and add only its file-probe tool")
    original=git(repo,"ls-tree","-rz","--name-only",APP_BASE).decode().rstrip("\0").split("\0")
    if len(original)!=460:raise AssertionError("Expected exact original460 tracked paths")
    old=blobs(repo,[APP_BASE+":"+p for p in original]);new=blobs(repo,[actual+":"+p for p in original])
    rows=[]
    for path,left,right in zip(original,old,new):
        if path==REPLACED_WORKFLOW:continue
        if left!=right:raise AssertionError("Original application blob changed: "+path)
        raw=(repo/path).read_bytes()
        if raw!=left and raw.replace(b"\r\n",b"\n")!=left:
            raise AssertionError("Original working file changed: "+path)
        rows.append({"path":path,"git_blob_sha256":digest(left),"working_raw_sha256":digest(raw)})
    helper=repo/"tools/check-safari-desktop.py"
    if digest(helper.read_bytes().replace(b"\r\n",b"\n"))!=HELPER_SHA:
        raise AssertionError("Committed V3 helper binding failed")
    qa_files=[]
    for path,blob in zip(sorted(QA_PATHS),blobs(repo,[actual+":"+p for p in sorted(QA_PATHS)])):
        raw=(repo/path).read_bytes()
        if raw!=blob and raw.replace(b"\r\n",b"\n")!=blob:
            raise AssertionError("Probe QA working file differs from committed blob: "+path)
        qa_files.append({"path":path,"working_raw_sha256":digest(raw),"git_blob_sha256":digest(blob)})
    if len(rows)!=459:raise AssertionError("Expected459 preserved original source paths")
    return {"app_source_sha":APP_BASE,"probe_head_sha":actual,"original_paths":459,
            "original459_blobs_identical":True,"replaced_qa_workflow":REPLACED_WORKFLOW,
            "rows":rows,"qa_files":qa_files}

def validate_png(data):
    if len(data)!=79 or list(data[:8])!=HEADER:raise AssertionError("Expected synthetic79-byte PNG")
    pos=8; payload=b""; dimensions=None; ended=False; chunks=[]
    while pos<len(data):
        length=struct.unpack(">I",data[pos:pos+4])[0];kind=data[pos+4:pos+8]
        body=data[pos+8:pos+8+length];crc=data[pos+8+length:pos+12+length]
        if len(body)!=length or len(crc)!=4 or zlib.crc32(kind+body)&0xffffffff!=struct.unpack(">I",crc)[0]:
            raise AssertionError("Synthetic PNG chunk CRC invalid")
        chunks.append(kind.decode("ascii"));pos+=12+length
        if kind==b"IHDR":dimensions=struct.unpack(">IIBBBBB",body)
        if kind==b"IDAT":payload+=body
        if kind==b"IEND":ended=True;break
    if pos!=len(data) or not ended or dimensions!=(16,16,8,6,0,0,0):
        raise AssertionError("Unexpected synthetic PNG structure")
    if len(zlib.decompress(payload))!=(16*4+1)*16:raise AssertionError("Synthetic PNG decode length invalid")
    return {"bytes":len(data),"sha256":digest(data),"width":16,"height":16,"crc_valid":True,"chunks":chunks}

def create_fixture(folder, location, timing, png):
    folder.mkdir(parents=True,exist_ok=False);path=folder/"synthetic-safari-file-fixture.png"
    with path.open("xb") as handle:
        handle.write(png);handle.flush();os.fsync(handle.fileno())
    sealed=time.monotonic();stat=path.stat()
    with path.open("rb") as handle:header=list(handle.read(8))
    if stat.st_size!=79 or header!=HEADER:raise AssertionError("Closed synthetic file is unreadable by host")
    return {"path":str(path.resolve()),"location":location,"timing":timing,
            "sealed_monotonic":sealed,"closed_before_selection":True,"bytes":stat.st_size,
            "mode":oct(stat.st_mode&0o777),"mtime_ms":round(stat.st_mtime*1000),
            "png_sha256":digest(png),"host_header":header}

def classify_case(case):
    read=case.get("reads") or {};meta=read.get("metadata") or {};ui=case.get("ui") or {}
    ok=case.get("sendkeys")=="accepted" and read.get("filePresent") is True
    ok=ok and read.get("changes")==1 and meta.get("name")=="synthetic-safari-file-fixture.png"
    ok=ok and meta.get("size")==79 and meta.get("type")=="image/png" and read.get("sameCapturedFile") is True
    ok=ok and all((read.get(api) or {}).get("ok") is True and read[api].get("header")==HEADER
                  for api in ["arrayBuffer","fileReader"])
    ok=ok and ui.get("preview") is True and not ui.get("alerts") and not case.get("errors")
    ok=ok and len(case.get("artifacts",[]))==2
    if case["surface"]=="blank":
        ok=ok and ui.get("isAboutBlank") is True and ui.get("appRootPresent") is False and ui.get("serviceWorkerControlled") is False
    else:
        ok=ok and ui.get("appRootPresent") is True and ui.get("isAboutBlank") is False
    return bool(ok)

def matrix_pass(cases):
    return len(cases)==6 and {c["id"] for c in cases}==set(CASE_IDS) and all(c.get("passed") is True for c in cases)

def load_helper(repo):
    spec=importlib.util.spec_from_file_location("committed_safari_v3",repo/"tools/check-safari-desktop.py")
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper);return helper

def one_case(helper,driver,base,out,case_id,fixture):
    native=case_id.startswith("blank-")
    row={"id":case_id,"surface":"blank" if native else "app","fixture":fixture,
         "sendkeys":"not_run","reads":None,"ui":None,"errors":[],"passed":False,"started_at_utc":utc()}
    try:
        driver.call("POST","/url",{"url":"about:blank"})
        if native:
            driver.execute("document.body.innerHTML='<label>Synthetic file<input id=\"native-file\" type=\"file\" accept=\"image/png\"></label><img id=\"native-preview\" alt=\"Synthetic file preview\">';")
            element=driver.find("#native-file")
        else:
            driver.call("POST","/url",{"url":base+"/#add"})
            element=helper.wait(lambda:driver.find('input[type="file"]'),"fresh actualApp #add",seconds=15)
            if driver.execute("return !!document.querySelector('.capture-preview');"):
                raise AssertionError("Fresh application page unexpectedly contains an old preview")
        driver.execute(CAPTURE_JS,[element,native])
        try:driver.keys(element,fixture["path"]);row["sendkeys"]="accepted"
        except helper.DriverError as exc:
            row["sendkeys"]="rejected";row["errors"].append({"kind":"native-sendkeys","code":exc.code,"message":str(exc)[:500]})
        # Always retain both API outcomes against the one captured synthetic File.
        row["reads"]=driver.execute_async(READ_JS)
        deadline=time.monotonic()+4
        while True:
            row["ui"]=driver.execute(UI_JS,[native])
            if row["ui"]["preview"] or row["ui"]["alerts"] or time.monotonic()>=deadline:break
            time.sleep(.2)
    except Exception as exc:
        row["errors"].append({"kind":"probe-execution","type":type(exc).__name__,"message":str(exc)[:600]})
    finally:
        try:
            row["artifacts"]=helper.snapshot(driver,out,case_id,required=True)
            if len(row["artifacts"])!=2:raise AssertionError("Required PNG/DOM pair missing")
        except Exception as exc:row["errors"].append({"kind":"required-evidence","type":type(exc).__name__,"message":str(exc)[:400]})
    row["passed"]=classify_case(row);row["status"]="PASS" if row["passed"] else "FAIL"
    row["completed_at_utc"]=utc()
    return row

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url",default="http://127.0.0.1:5190")
    parser.add_argument("--driver-url",default="http://127.0.0.1:9515")
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--source-sha",required=True)
    args=parser.parse_args()
    if not re.fullmatch("[0-9a-f]{40}",args.source_sha):parser.error("Full probe GitSHA required")
    repo=Path(__file__).resolve().parents[1];out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
    if (out/"receipt.json").exists():raise RuntimeError("Refusing to overwrite a previous receipt")
    began=utc();driver=None;cases=[];failure=None;source=None;cleanup=None;identity={};png_info=None;temporary=None
    try:
        if platform.system()!="Darwin":raise RuntimeError("Native macOS Safari only; no WebKit substitution")
        source=audit_source(repo,args.source_sha)
        helper=load_helper(repo);base=helper.loopback(args.base_url);endpoint=helper.loopback(args.driver_url)
        png=base64.b64decode(helper.PNG,validate=True);png_info=validate_png(png)
        (out/"synthetic-fixture.png").write_bytes(png)
        driver=helper.WebDriver(endpoint);identity["readiness"]=helper.wait_readiness(driver,base)
        workspace=repo/".local"/("safari-file-fixture-"+str(time.time_ns()))
        temporary=tempfile.TemporaryDirectory(prefix="yzt-safari-file-fixture-")
        temp_root=Path(temporary.name)
        fixtures={}
        for location,root in [("workspace",workspace),("tmp",temp_root)]:
            fixtures[location+"-before"]=create_fixture(root/"before",location,"before",png)
        started=time.monotonic();caps=driver.start();ready=time.monotonic()
        identity.update({"session_started_monotonic":started,"session_ready_monotonic":ready,
            "capabilities":{k:v for k,v in caps.items() if k in {"browserName","browserVersion","platformName","pageLoadStrategy"}},
            "macos":platform.mac_ver()[0],"safaridriver":subprocess.check_output(["/usr/bin/safaridriver","--version"],text=True).strip()})
        for location,root in [("workspace",workspace),("tmp",temp_root)]:
            fixtures[location+"-after"]=create_fixture(root/"after",location,"after",png)
        for fixture in fixtures.values():
            if not (fixture["sealed_monotonic"]<started if fixture["timing"]=="before" else fixture["sealed_monotonic"]>=ready):
                raise AssertionError("File/session timing control invalid")
        driver.call("POST","/window/rect",{"width":1366,"height":1000})
        driver.call("POST","/url",{"url":base+"/"})
        driver.click(helper.button(driver,"本機使用者"))
        helper.wait(lambda:driver.execute("return document.body.innerText.includes('今天的用藥日常');"),"isolated local login",seconds=15)
        for case_id in CASE_IDS:
            key="-".join(case_id.split("-")[1:])
            cases.append(one_case(helper,driver,base,out,case_id,fixtures[key]))
        after=audit_source(repo,args.source_sha)
        if [r["working_raw_sha256"] for r in source["rows"]]!=[r["working_raw_sha256"] for r in after["rows"]]:
            raise AssertionError("Original459 working source bytes changed during probe")
        source["original459_working_raw_stable"]=True
        if source["qa_files"]!=after["qa_files"]:raise AssertionError("Probe QA source changed during execution")
    except Exception as exc:
        failure={"type":type(exc).__name__,"message":str(exc)[:1400]}
    finally:
        if driver:
            try:driver.close();cleanup="session_deleted"
            except Exception as exc:cleanup="session_delete_failed";failure=failure or {"type":type(exc).__name__,"message":str(exc)[:500]}
        if temporary:
            try:temporary.cleanup()
            except Exception as exc:failure=failure or {"type":type(exc).__name__,"message":"Synthetic temporary-directory cleanup failed"}
    passed=failure is None and matrix_pass(cases)
    receipt={"schema":"native-safari-synthetic-file-fixture/v1","status":"PASS" if passed else "FAIL","passed":passed,
        "execution_completed":len(cases)==6,"started_at_utc":began,"completed_at_utc":utc(),
        "app_source_sha":APP_BASE,"probe_head_sha":args.source_sha,"tool_sha256":digest(Path(__file__).read_bytes()),
        "committed_helper_sha256":HELPER_SHA,"source":source,"identity":identity,"fixture":png_info,
        "matrix_ids":CASE_IDS,"cases":cases,"failure":failure,"cleanup":cleanup,
        "commands":driver.commands if driver else [],
        "artifacts":[{"path":p.name,"bytes":p.stat().st_size,"sha256":digest(p.read_bytes())} for p in sorted(out.iterdir()) if p.is_file()],
        "scope":"Four actualApp native selections, two about:blank controls reusing preclosed workspace/tmp files. Each API reads only same capturedFile.slice(0,8). No fallback, recognition, medication save or realAI.",
        "privacy":"Only created synthetic79-byte PNG files; no cookies/tokens/headers/session credentials read into receipt. WebDriver command bodies omitted.",
        "network_scope":"HTTP client initialURLs restricted127.0.0.1; Node application guard required by workflow. Native OS browser background traffic is not globally firewalled.",
        "result_limit":"Any failed/absent file selection/read/preview/evidence makes that case and fullmatrixFAIL. App versus blank controls are separate; cause remains undetermined until reviewed. Not13core workflows or OS picker/camera coverage."}
    (out/"receipt.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"passed":passed,"cases":len(cases),"failed":[c["id"] for c in cases if not c["passed"]],"failure":failure,"receipt":str(out/"receipt.json")},ensure_ascii=False))
    return 0 if passed else 1

if __name__=="__main__":raise SystemExit(main())

