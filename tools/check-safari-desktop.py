#!/usr/bin/env python3
"""Native macOS Safari smoke check via Apple's W3C WebDriver, not Playwright WebKit.

Start the existing isolated tests/support/e2e-server.ts and /usr/bin/safaridriver
separately. This standard-library client never enables automation, installs tools,
loads credentials, navigates to production, or invokes a real AI provider.
"""
from __future__ import annotations
import argparse, base64, datetime as dt, hashlib, json, platform, re, subprocess, sys, time
from pathlib import Path
from urllib import error, parse, request

ELEMENT = "element-6066-11e4-a52e-4f735466cecf"
PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg=='

def loopback(value: str) -> str:
    url = parse.urlsplit(value)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
        raise ValueError("Only explicit http://127.0.0.1 loopback URLs are permitted")
    return value.rstrip("/")

def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()

class DriverError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message); self.code = code

class WebDriver:
    def __init__(self, url: str):
        self.url = loopback(url); self.session = ""; self.commands = []; self.evidence = []; self.diagnostics = {}
        self.http = request.build_opener(request.ProxyHandler({}))
    def command(self, method: str, path: str, body=None):
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = request.Request(self.url + path, data=data, method=method, headers={"Content-Type": "application/json; charset=utf-8"})
        began = time.monotonic()
        try:
            with self.http.open(req, timeout=65) as response: status, raw = response.status, response.read()
        except error.HTTPError as exc:
            status, raw = exc.code, exc.read()
        payload = json.loads(raw.decode("utf-8")); value = payload.get("value")
        # Record command type/timing, never request bodies, auth/session tokens or model input.
        route = path.replace(self.session, "<session>") if self.session else path
        self.commands.append({"method": method, "path": route, "http_status": status, "duration_ms": round((time.monotonic()-began)*1000)})
        if status >= 400 and isinstance(value, dict) and value.get("error"):
            raise DriverError(str(value["error"]), str(value.get("message", "WebDriver command failed"))[:1200])
        if status >= 400: raise DriverError("http_error", "WebDriver HTTP " + str(status))
        return value
    def call(self, method: str, path: str, body=None):
        return self.command(method, "/session/" + self.session + path, body)
    def start(self):
        value = self.command("POST", "/session", {"capabilities": {"alwaysMatch": {"browserName": "safari"}}})
        self.session = value["sessionId"]; caps = value["capabilities"]
        if str(caps.get("browserName", "")).lower() != "safari":
            raise DriverError("wrong_browser", "Driver did not return native Safari capabilities")
        self.call("POST", "/timeouts", {"implicit": 0, "pageLoad": 45000, "script": 30000})
        return caps
    def execute(self, script: str, args=None):
        return self.call("POST", "/execute/sync", {"script": script, "args": args or []})
    def execute_async(self, script: str, args=None):
        return self.call("POST", "/execute/async", {"script": script, "args": args or []})
    def find(self, selector: str, using="css selector"):
        return self.call("POST", "/element", {"using": using, "value": selector})
    def click(self, element):
        self.execute("arguments[0].scrollIntoView({block:'center'});", [element])
        return self.call("POST", "/element/" + element[ELEMENT] + "/click", {})
    def keys(self, element, text: str):
        return self.call("POST", "/element/" + element[ELEMENT] + "/value", {"text": text, "value": list(text)})
    def fill(self, element, text: str):
        self.call("POST", "/element/" + element[ELEMENT] + "/clear", {})
        self.keys(element, text)
        wait(lambda: self.execute("return arguments[0].value===arguments[1];", [element,text]), "native input value")
    def close(self):
        if self.session:
            try: self.call("DELETE", "")
            finally: self.session = ""


def wait(condition, description: str, seconds=30):
    end = time.monotonic() + seconds; last = None
    while time.monotonic() < end:
        try:
            value = condition()
            if value: return value
        except DriverError as exc:
            if exc.code not in {"no such element", "stale element reference"}: raise
            last = exc
        time.sleep(.2)
    raise AssertionError("Timed out: " + description + (" ("+str(last)+")" if last else ""))


def wait_readiness(driver, base: str, seconds=60):
    """Retry connection startup only; wrong app mode or malformed replies fail immediately."""
    start=time.monotonic(); deadline=start+seconds
    result={"started_at_utc":utc(),"polls":0}; app=None; state=None
    def read(url):
        remaining=deadline-time.monotonic()
        if remaining<=0: raise AssertionError("Loopback readiness exceeded60seconds")
        try:
            with driver.http.open(request.Request(url,method="GET"),timeout=min(3,remaining)) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            if exc.code==502:return None
            raise
        except (error.URLError,ConnectionRefusedError):return None
    while time.monotonic()<deadline:
        result["polls"]+=1
        if app is None:
            value=read(base+"/api/v1/config")
            if value is not None:
                if not isinstance(value,dict) or value.get("mode")!="local":
                    raise RuntimeError("Readiness refused: app config mode must be local")
                app=value;result["app_ready_at_utc"]=utc()
        if state is None:
            value=read(driver.url+"/status")
            if value is not None:
                if not isinstance(value,dict) or not isinstance(value.get("value"),dict):
                    raise RuntimeError("Readiness refused: invalid WebDriver status reply")
                state=value["value"];result["driver_ready_at_utc"]=utc()
        if app is not None and state is not None:
            result["duration_ms"]=round((time.monotonic()-start)*1000)
            result["app_mode"]=app["mode"];result["driver_status"]=state;return result
        time.sleep(min(.25,max(0,deadline-time.monotonic())))
    raise AssertionError("Loopback app/driver readiness exceeded60seconds")


def button(driver, text):
    if "'" in text: raise ValueError("Unsupported quote in exact test locator")
    return wait(lambda: driver.find("//button[normalize-space(.)='"+text+"']", "xpath"), "button "+text)


def snapshot(driver, out: Path, label: str, required=True):
    if not driver.session: return []
    paths = []; errors = []
    try:
        encoded = driver.call("GET", "/screenshot")
        data=base64.b64decode(encoded,validate=True)
        if len(data)<32 or data[:8]!=bytes([137,80,78,71,13,10,26,10]): raise ValueError("Screenshot is not a nonempty PNG")
        p = out/(label+".png"); p.write_bytes(data); paths.append(p.name)
    except Exception as exc: errors.append("screenshot:"+type(exc).__name__+":"+str(exc)[:300])
    try:
        html = driver.execute("const root=document.documentElement.cloneNode(true);root.querySelectorAll('input').forEach(e=>{e.removeAttribute('value');});root.querySelectorAll('textarea').forEach(e=>e.textContent='');return root.outerHTML;")
        if not isinstance(html,str) or len(html)<100 or "<body" not in html: raise ValueError("DOM evidence is empty or invalid")
        p = out/(label+".html"); p.write_text(html, encoding="utf-8"); paths.append(p.name)
    except Exception as exc: errors.append("DOM:"+type(exc).__name__+":"+str(exc)[:300])
    driver.evidence.append({"checkpoint":label,"required":required,"status":"PASS" if len(paths)==2 else "FAIL","paths":paths,"errors":errors})
    if required and len(paths)!=2: raise AssertionError("Required screenshot/DOM missing at "+label+": "+";".join(errors))
    return paths


def upload(driver, path: Path, checks, out: Path):
    element = wait(lambda: driver.find('input[type="file"]'), "photo input")
    diagnostic={"native_sendkeys":"not_run","native_read":None,"native_file_reader":None,"native_preview":False,"os_picker_tested":False}
    driver.diagnostics["synthetic_file_readability"]=diagnostic
    # Preserve just the selected synthetic File reference before the app may clear
    # an unreadable input. The observer does not cancel/change the app's event.
    driver.execute("const input=arguments[0];window.__nativeSafariFileObserver=()=>{window.__nativeSafariSelectedFile=input.files?.[0]||null;};input.addEventListener('change',window.__nativeSafariFileObserver,{capture:true,once:true});",[element])
    try:
        driver.keys(element, str(path.resolve()))
        diagnostic["native_sendkeys"]="accepted"
        # Read only the one synthetic test file and at most its PNG signature.
        diagnostic["native_read"]=driver.execute_async("""
const input=arguments[0],done=arguments[arguments.length-1],file=window.__nativeSafariSelectedFile||(input.files&&input.files[0]);
const meta=file?{name:file.name,type:file.type,size:file.size,lastModified:file.lastModified}:null;
let finished=false;const finish=v=>{if(!finished){finished=true;done(v);}};
setTimeout(()=>finish({ok:false,metadata:meta,error:'header-read-timeout'}),8000);
if(!file){finish({ok:false,metadata:meta,error:'no-file-after-native-selection'});return;}
file.slice(0,8).arrayBuffer().then(b=>finish({ok:true,metadata:meta,header:Array.from(new Uint8Array(b))}),e=>finish({ok:false,metadata:meta,error:String(e.name)+': '+String(e.message)}));
""",[element])
        read=diagnostic["native_read"]
        if not read.get("ok") or read.get("header")!=[137,80,78,71,13,10,26,10]:
            raise DriverError("native_file_unreadable",json.dumps(read,ensure_ascii=False))
        wait(lambda: driver.execute("const e=document.querySelector('.capture-preview img');return !!e&&e.complete&&e.naturalWidth>0;"), "native synthetic photo preview",seconds=8)
        diagnostic["native_preview"]=True; kind="native-input-sendkeys"
        checks.append({"id":"native-file-input","status":"passed","scope":"Readable synthetic file selected through WebDriver; OS picker not tested"})
    except (DriverError,AssertionError) as exc:
        # This fallback remains a distinct coverage claim, never native file picker coverage.
        diagnostic["native_failure"]={"type":type(exc).__name__,"code":getattr(exc,"code",None),"message":str(exc)[:1200]}
        if diagnostic["native_sendkeys"]=="accepted" and not (diagnostic["native_read"] or {}).get("ok"):
            # Read the same captured synthetic File slice via the alternate native
            # browser API. This diagnostic is not an app/fallback upload pass.
            diagnostic["native_file_reader"]=driver.execute_async("""
const input=arguments[0],done=arguments[arguments.length-1],file=window.__nativeSafariSelectedFile||(input.files&&input.files[0]);
const metadata=file?{name:file.name,type:file.type,size:file.size,lastModified:file.lastModified}:null;
let ended=false;const finish=x=>{if(!ended){ended=true;done(x);}};
if(!file){finish({ok:false,metadata,error:'no-file-for-FileReader-control'});return;}
const reader=new FileReader();
setTimeout(()=>{finish({ok:false,metadata,error:'FileReader-read-timeout'});try{reader.abort();}catch{}},8000);
reader.onload=()=>finish({ok:true,metadata,header:Array.from(new Uint8Array(reader.result))});
reader.onerror=()=>finish({ok:false,metadata,error:String(reader.error?.name)+': '+String(reader.error?.message)});
reader.onabort=()=>finish({ok:false,metadata,error:'FileReader-aborted'});
try{reader.readAsArrayBuffer(file.slice(0,8));}catch(e){finish({ok:false,metadata,error:String(e.name)+': '+String(e.message)});}
""",[element])
            diagnostic["requires_product_api_compatibility_review"]=bool(diagnostic["native_file_reader"].get("ok"))
            diagnostic["readability_interpretation"]=("arrayBuffer failed but FileReader could read the same synthetic file; investigate product API compatibility before release" if diagnostic["requires_product_api_compatibility_review"] else "Both diagnostic paths did not establish a readable native-selected file; cause remains undetermined")
        diagnostic["native_visible_alerts"]=driver.execute("return Array.from(document.querySelectorAll('[role=alert]')).map(e=>e.innerText);")
        snapshot(driver,out,"native-file-limitation",required=False)
        checks.append({"id":"native-file-input","status":"file-read-limited","detail":diagnostic["native_failure"],"scope":"Native file selection/read/preview did not pass; cause undetermined. Frontend in-memory fallback tested separately; FileReader diagnostic alone is not an app pass."})
        element = wait(lambda: driver.find('input[type="file"]'), "fallback photo input")
        driver.execute("arguments[0].removeEventListener('change',window.__nativeSafariFileObserver,true);delete window.__nativeSafariFileObserver;delete window.__nativeSafariSelectedFile;",[element])
        driver.execute("const input=arguments[0],bytes=new Uint8Array(arguments[1]);const dt=new DataTransfer();dt.items.add(new File([bytes],'synthetic-safari.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));", [element, list(path.read_bytes())])
        kind = "dom-file-datatransfer"
    finally:
        driver.execute("arguments[0].removeEventListener('change',window.__nativeSafariFileObserver,true);delete window.__nativeSafariFileObserver;delete window.__nativeSafariSelectedFile;",[element])
    wait(lambda: driver.execute("const e=document.querySelector('.capture-preview img');return !!e&&e.complete&&e.naturalWidth>0;"), "synthetic photo preview")
    diagnostic["frontend_upload_method"]=kind
    return diagnostic


def probe(driver, base: str, out: Path, checks):
    driver.call("POST", "/url", {"url": base+"/"})
    wait(lambda: driver.execute("return document.body.innerText.includes('把用藥');"), "public app shell")
    checks.append({"id": "public-shell", "status": "passed"}); snapshot(driver,out,"probe-shell")
    driver.click(button(driver,"本機使用者"))
    wait(lambda: driver.execute("return document.body.innerText.includes('今天的用藥日常');"), "synthetic local login")
    checks.append({"id": "synthetic-login", "status": "passed"})
    driver.call("POST", "/url", {"url": base+"/#add"})
    wait(lambda: driver.find('input[type="file"]'), "add photo page")
    image = out/"synthetic-safari.png"; image.write_bytes(base64.b64decode(PNG))
    diagnostic = upload(driver,image,checks,out); method=diagnostic["frontend_upload_method"]
    checks.append({"id": "frontend-file-preview", "status": "passed", "method": method, "os_picker_tested": False, "real_photo_or_AI": False})
    snapshot(driver,out,"probe-upload")
    return {"upload_method": method,"file_diagnostic":diagnostic,"user_agent": driver.execute("return navigator.userAgent;"), "url": driver.call("GET", "/url")}


def text_element(driver, selector: str, text: str, exact=True):
    return wait(lambda: driver.execute("return Array.from(document.querySelectorAll(arguments[0])).find(e=>arguments[2]?e.textContent.trim()===arguments[1]:e.textContent.includes(arguments[1]))||null;",[selector,text,exact]),"visible text target "+text)


def field(driver, label: str):
    return wait(lambda: driver.execute("return Array.from(document.querySelectorAll('label.field')).find(e=>e.querySelector('span')?.textContent.trim()===arguments[0])?.querySelector('input,textarea,select')||null;",[label]),"field "+label)


def body_has(driver, text: str, seconds=30):
    return wait(lambda: driver.execute("return document.body.innerText.includes(arguments[0]);",[text]),"visible text "+text,seconds)


def check(driver, checks, name: str, **detail):
    checks.append({"id":name,"status":"passed",**detail})
    print(json.dumps({"checkpoint":name,"status":"passed"},ensure_ascii=False),flush=True)


def service_worker_state(driver, checks, label: str):
    """Real Safari SW state/cache proof, never a fixture or a substituted ready promise."""
    result=driver.execute_async("""
const done=arguments[arguments.length-1],started=performance.now(),deadline=started+15000;
const expectedScope=location.origin+'/',expectedScript=location.origin+'/sw.js';
let ended=false,readyScope=null,registrations=[],polls=0,pollTimer;
const history=[];
const finish=x=>{if(!ended){ended=true;clearTimeout(timeout);clearTimeout(pollTimer);
 done({...x,readyScope,registrations,polls,elapsedMs:Math.round(performance.now()-started),history});}};
const timeout=setTimeout(()=>finish({ok:false,error:'service-worker-ready-timeout'}),15000);
if(!('serviceWorker' in navigator)){finish({ok:false,error:'service-worker-unsupported'});return;}
navigator.serviceWorker.ready.then(ready=>{
 readyScope=ready.scope;
 const poll=async()=>{
  if(ended)return;
  if(performance.now()>=deadline){finish({ok:false,error:'service-worker-ready-timeout'});return;}
  try{
   const regs=await navigator.serviceWorker.getRegistrations();
   if(ended)return;
   registrations=regs.map(r=>({scope:r.scope,active:r.active?{scriptURL:r.active.scriptURL,state:r.active.state}:null}));
   polls++;
   if(!history.length||JSON.stringify(history[history.length-1].registrations)!==JSON.stringify(registrations))
    history.push({elapsedMs:Math.round(performance.now()-started),registrations});
   if(performance.now()>=deadline){finish({ok:false,error:'service-worker-ready-timeout'});return;}
   if(readyScope===expectedScope&&registrations.some(r=>r.scope===expectedScope&&r.active?.scriptURL===expectedScript&&r.active.state==='activated')){
    finish({ok:true});return;
   }
   pollTimer=setTimeout(poll,Math.min(100,deadline-performance.now()));
  }catch(e){finish({ok:false,error:String(e.name)+': '+String(e.message)});}
 };
 void poll();
}).catch(e=>finish({ok:false,error:String(e.name)+': '+String(e.message)}));
""")
    driver.diagnostics[label]=result
    if not result.get("ok"):raise AssertionError("Native Safari real service worker not ready: "+str(result.get("error")))
    active=[r for r in result["registrations"] if (r.get("active") or {}).get("state")=="activated" and r["scope"]==driver.execute("return location.origin+'/';")]
    if not active:raise AssertionError("No activated same-origin application service worker")
    controller=wait(lambda: driver.execute("const c=navigator.serviceWorker.controller;return c&&c.state==='activated'?{scriptURL:c.scriptURL,state:c.state}:null;"),"real Safari page controlled by activated SW",seconds=15)
    origin=driver.execute("return location.origin;")
    if controller["scriptURL"]!=origin+"/sw.js":raise AssertionError("Unexpected service worker controller")
    cache=driver.execute_async("""
const done=arguments[arguments.length-1];caches.keys().then(async names=>{
 const rows=await Promise.all(names.map(async name=>({name,paths:(await (await caches.open(name)).keys()).map(r=>new URL(r.url).pathname)})));
 done({ok:true,rows});
}).catch(e=>done({ok:false,error:String(e.name)+': '+String(e.message)}));
""")
    if not cache.get("ok"):raise AssertionError("Could not inspect actual Safari public shell cache")
    paths=[p for row in cache["rows"] for p in row["paths"]]
    if not any(p.startswith("/assets/") and p.endswith(".js") for p in paths):raise AssertionError("Activated Safari SW has no cached application JS")
    if any(p.startswith(("/api/","/uploads/","/internal/")) for p in paths):raise AssertionError("Private API or uploaded image unexpectedly cached")
    result.update({"controller":controller,"cache":cache["rows"],"private_api_or_upload_cached":False})
    check(driver,checks,label,registered=True,activated=True,controlled=True,public_js_cached=True,private_api_or_upload_cached=False)
    return result


def local_read(driver, path: str):
    """Browser-origin authenticated GET; session token never leaves browser memory."""
    if not re.fullmatch(r"/(medications|learning|chat|jobs|schedules)(/[a-zA-Z0-9_-]+)?",path):
        raise ValueError("Unexpected local verification route")
    value=driver.execute_async("""
const path=arguments[0],done=arguments[arguments.length-1];
fetch('/api/v1'+path,{headers:{authorization:'Bearer '+sessionStorage.getItem('yzt-local-token')},cache:'no-store'})
.then(async r=>{const body=await r.json();done({ok:r.ok,status:r.status,body});})
.catch(e=>done({ok:false,error:String(e.name)+': '+String(e.message)}));
""",[path])
    if not value.get("ok"): raise AssertionError("Local verification GET failed: "+path+" "+str(value.get("status",value.get("error"))))
    return value["body"]


def citation_check(result):
    chunks={c["id"]:c for c in result.get("chunks",[])}; found=[]
    for item in result.get("claims",[])+result.get("quiz",[]):
        citations=item.get("citations",[])
        if not citations: raise AssertionError("Synthetic saved content is missing citations")
        for cite in citations:
            chunk=chunks.get(cite["chunkId"])
            if not chunk or not cite["quote"] or cite["quote"] not in chunk["text"]:
                raise AssertionError("Saved citation does not literally match its synthetic chunk")
            if result["sourceVersions"].get(chunk["licenseNo"])!=chunk["version"]:
                raise AssertionError("Saved citation version does not match sourceVersions")
            found.append({"chunkId":chunk["id"],"literal":True,"version":chunk["version"]})
    if not found: raise AssertionError("No synthetic source references were verified")
    return found


def long_presentation(driver, out: Path, checks):
    """Explicit frontend-only public fixture, separated from real local API persistence."""
    fixture_path=Path(__file__).resolve().parents[1]/"tests/fixtures/quiz-presentation-saved-source.json"
    fixture=json.loads(fixture_path.read_text(encoding="utf-8"))
    driver.execute("location.hash='home';")
    body_has(driver,"今天的用藥日常")
    driver.execute("""
const f=arguments[0],qid='synthetic-native-long-question',rid='synthetic-native-long-record';
const citation={chunkId:'public-wording-synthetic-binding',quote:f.options[1]};
const result={status:'supported',claims:[{text:f.options[1],kind:'source_exact_safety',category:'warning',citations:[citation]}],chunks:[{id:citation.chunkId,licenseNo:'SYNTHETIC-PRESENTATION',version:'public-text-fixture',page:2,start:0,text:citation.quote}],quiz:[{...f,id:qid,answer:1,explain:f.options[1],citations:[citation]}],followups:[],rejectedCount:0,sourceVersions:{},verification:'model_assisted'};
const record={id:rid,ownerId:'synthetic-presentation-owner',medicationIds:[],medicationRevisions:[],profileVersion:0,result,answers:{[qid]:0},createdAt:'2026-10-24T00:00:00Z'};
const state={fixture:f,record,original:JSON.stringify(result),writes:[],originalFetch:window.fetch};
window.__nativeSafariPresentation=state;
window.fetch=async function(input,options){
 const url=new URL(typeof input==='string'?input:input.url,location.href),method=(options?.method||input?.method||'GET').toUpperCase();
 if(url.origin===location.origin&&url.pathname==='/api/v1/learning'&&method==='GET')return new Response(JSON.stringify({items:[record]}),{status:200,headers:{'Content-Type':'application/json'}});
 if(url.origin===location.origin&&url.pathname==='/api/v1/learning/'+rid+'/answers'&&method==='POST'){
  const body=JSON.parse(options.body);state.writes.push(body);record.answers={...record.answers,...body.answers};
  const selected=record.answers[qid],correct=selected===1,answered=Number.isInteger(selected);
  return new Response(JSON.stringify({answers:record.answers,progress:{total:1,answered:answered?1:0,correct:correct?1:0,passed:correct,status:correct?'completed':answered?'in_progress':'not_started',results:[{id:qid,state:!answered?'unanswered':correct?'correct':'incorrect',correct,answer:1,explain:f.options[1]}]}}),{status:200,headers:{'Content-Type':'application/json'}});
 }
 return state.originalFetch.apply(this,arguments);
};
location.hash='learning?record='+rid+'&section=quiz';
""",[fixture])
    try:
        wait(lambda: driver.find(".quiz .quiz-shared-context"),"public long-question presentation fixture")
        shared=driver.execute("return document.querySelector('.quiz-shared-context').textContent;")
        if "六、本藥不得與含酒精飲料併服。" not in shared: raise AssertionError("Shared trailing source condition missing")
        options=driver.execute("return Array.from(document.querySelectorAll('.quiz-option-text')).map(e=>e.textContent);")
        if len(options)!=2 or not all("五、服藥後若有不適情況發生," in x for x in options):
            raise AssertionError("Long option condition/core was omitted")
        driver.click(text_element(driver,".question-original summary","查看完整題目與選項"))
        original=wait(lambda: driver.execute("const e=document.querySelector('.question-original');return e?.open?{q:e.querySelector('p').textContent,options:Array.from(e.querySelectorAll('li')).map(x=>x.textContent)}:null;"),"expanded original question")
        if original!={"q":fixture["q"],"options":fixture["options"]}: raise AssertionError("Original question/options are not byte-for-byte JS strings")
        if not driver.execute("return document.documentElement.scrollWidth<=innerWidth;"): raise AssertionError("Long fixture overflows desktop viewport")
        snapshot(driver,out,"core-long-original")
        driver.click(driver.find('.quiz input[type="radio"][value="1"]'))
        wait(lambda: driver.execute("return document.querySelector('.quiz input[value=\"1\"]').checked;"),"long correct option checked")
        driver.click(button(driver,"檢查答案"))
        wait(lambda: driver.find('.question-complete[aria-label="理解測驗完成"]'),"long fixture completion")
        proof=driver.execute("const s=window.__nativeSafariPresentation;return {unchanged:JSON.stringify(s.record.result)===s.original,writes:s.writes,answers:s.record.answers};")
        if proof!={"unchanged":True,"writes":[{"answers":{"synthetic-native-long-question":1}}],"answers":{"synthetic-native-long-question":1}}:
            raise AssertionError("Long fixture altered source strings/index or posted wrong answer ID")
        snapshot(driver,out,"core-long-complete")
        check(driver,checks,"public-long-presentation",scope="Frontend fetch fixture only; not backend generation, read gate or backend persistence",fixture_sha256=hashlib.sha256(fixture_path.read_bytes()).hexdigest(),question_original_exact=True,options_original_exact=True,answer_id_index=proof["writes"],result_unchanged=True)
        return {"scope":"Frontend-only public wording fixture; actual short-question backend persistence tested separately","fixture_sha256":hashlib.sha256(fixture_path.read_bytes()).hexdigest(),"original_question_chars":len(fixture["q"]),"original_option_chars":[len(x) for x in fixture["options"]]}
    finally:
        driver.execute("const s=window.__nativeSafariPresentation;if(s){window.fetch=s.originalFetch;delete window.__nativeSafariPresentation;}")


def core(driver, base: str, out: Path, checks):
    details=probe(driver,base,out,checks)
    details["service_worker_before"]=service_worker_state(driver,checks,"real-service-worker-active")
    driver.click(button(driver,"開始辨識"))
    driver.click(text_element(driver,".capture-candidate","SYNTHETIC-E2E-5",exact=False))
    for label in ["每次劑量","頻次原文"]:
        if driver.execute("return arguments[0].value;",[field(driver,label)])!="": raise AssertionError("Unknown recognition field was silently filled: "+label)
    for label,value in [("每次劑量","1"),("劑量單位","錠"),("頻次原文","QD"),("包裝上的完整許可證字號","SYNTHETIC-E2E-5")]:
        driver.fill(field(driver,label),value)
    driver.click(button(driver,"核對產品資料"))
    body_has(driver,"包裝資料已與官方藥品資料核對。")
    usage=wait(lambda: driver.execute("return Array.from(document.querySelectorAll('label')).find(e=>e.textContent.includes(arguments[0]))?.querySelector('input[type=checkbox]')||null;",["我已對照藥袋確認用法（每次用量、頻次與途徑）"]),"usage confirmation")
    driver.click(usage)
    if not driver.execute("return arguments[0].checked;",[usage]): raise AssertionError("Usage checkbox did not become checked")
    snapshot(driver,out,"core-product-review")
    driver.click(button(driver,"儲存已核對藥品與用法"))
    # Photo save can stay on the add page; explicitly open its persisted directory.
    body_has(driver,"已儲存")
    driver.execute("location.hash='medications';")
    wait(lambda: driver.find(".med-card"),"saved medication card")
    medications=local_read(driver,"/medications")["items"]
    if len(medications)!=1: raise AssertionError("Native core requires a fresh isolated account with exactly one saved medication")
    med=medications[0]
    if not (med.get("licenseNo")=="SYNTHETIC-E2E-5" and med.get("confirmed") and med.get("identityReview",{}).get("status")=="confirmed" and med.get("doseAmount")==1 and med.get("frequencyRaw")=="QD"):
        raise AssertionError("Saved medication identity/usage differs from checked synthetic input")
    check(driver,checks,"recognition-review-save",medication_id=med["id"],synthetic_provider=True,unknown_fields_remained_blank=True)
    driver.click(button(driver,"仿單說明"))
    wait(lambda: driver.find(".evidence .quiz"),"real local API education/quiz",seconds=60)
    driver.click(text_element(driver,".evidence summary","對照仿單原文"))
    wait(lambda: driver.execute("return Array.from(document.querySelectorAll('.evidence details[open] blockquote')).some(e=>e.innerText.includes('SYNTHETIC-E2E-5')&&e.innerText.includes('fixture-'));"),"literal synthetic source citation visible")
    snapshot(driver,out,"core-source-citation")
    rows=local_read(driver,"/learning")["items"]
    learning=next((r for r in rows if med["id"] in r["medicationIds"]),None)
    if not learning or len(learning["result"]["quiz"])!=2: raise AssertionError("Expected the two existing synthetic provider questions")
    refs=citation_check(learning["result"])
    driver.click(driver.find('.quiz input[type="radio"][value="1"]'))
    driver.click(button(driver,"檢查答案"));body_has(driver,"再看一下：")
    snapshot(driver,out,"core-wrong-answer")
    wrong=next(r for r in local_read(driver,"/learning")["items"] if r["id"]==learning["id"])
    first_id=learning["result"]["quiz"][0]["id"]
    if wrong.get("answers",{}).get(first_id)!=1: raise AssertionError("Wrong-answer feedback was not persisted against the first question ID")
    driver.click(driver.find('.quiz input[type="radio"][value="0"]'))
    driver.click(button(driver,"檢查答案"));body_has(driver,"答對了。")
    driver.click(button(driver,"下一題"));body_has(driver,"第 2／2 題")
    driver.click(driver.find('.quiz input[type="radio"][value="0"]'))
    driver.click(button(driver,"檢查答案"))
    wait(lambda: driver.find('.question-complete[aria-label="理解測驗完成"]'),"all real local answers saved")
    snapshot(driver,out,"core-quiz-complete")
    expected={q["id"]:q["answer"] for q in learning["result"]["quiz"]}
    saved=next(r for r in local_read(driver,"/learning")["items"] if r["id"]==learning["id"])
    if saved.get("answers")!=expected: raise AssertionError("Saved real local quiz IDs/answer indexes differ")
    record_hash="learning?record="+learning["id"]+"&section=quiz"
    driver.call("POST","/url",{"url":base+"/#"+record_hash})
    driver.call("POST","/refresh",{})
    wait(lambda: driver.find('.question-complete[aria-label="理解測驗完成"]'),"saved quiz after actual reload")
    check(driver,checks,"local-source-and-quiz-save-reload",learning_id=learning["id"],questions=2,saved_answers=expected,citations=refs,wrong_answer_saved_then_corrected=True)
    driver.execute("location.hash='medications';")
    driver.click(button(driver,"排定提醒"))
    reminder=field(driver,"每天提醒時間（24 小時制，可用逗號分隔）")
    if driver.execute("return arguments[0].type;",[reminder])!="text": raise AssertionError("Reminder fixture input type changed")
    driver.fill(reminder,"25:99");driver.click(button(driver,"確認提醒時間"))
    wait(lambda: driver.execute("return arguments[0].getAttribute('aria-invalid')==='true'&&document.activeElement===arguments[0];",[reminder]),"invalid reminder focuses its field")
    if local_read(driver,"/schedules")["items"]: raise AssertionError("Invalid reminder was saved")
    snapshot(driver,out,"core-reminder-invalid")
    driver.fill(reminder,"08:00, 20:00");driver.click(button(driver,"確認提醒時間"))
    wait(lambda: driver.execute("return !document.querySelector('.schedule-form');"),"reminder save acknowledged by closed form")
    schedules=local_read(driver,"/schedules")["items"]
    if len(schedules)!=1 or schedules[0].get("medicationId")!=med["id"] or schedules[0].get("times")!=["08:00","20:00"]: raise AssertionError("Saved reminder times differ")
    snapshot(driver,out,"core-reminder-saved")
    check(driver,checks,"reminder-validation-save",input_type="text",invalid_rejected=True,valid_times=schedules[0]["times"],scope="Saved schedule, not lock-screen/OS notification delivery")
    driver.execute("location.hash='chat';")
    selected=wait(lambda: driver.find('.chat-selector input[type="checkbox"][aria-label="流程測試片 5mg"]'),"chat medication selection")
    if not driver.execute("return arguments[0].checked;",[selected]):driver.click(selected)
    question="請依合成仿單說明這份資料的用途，並附原文依據。"
    driver.fill(driver.find('textarea[aria-label="用藥問題"]'),question);driver.click(button(driver,"送出"))
    body_has(driver,"問題已處理完成，回答已儲存於問答紀錄。",seconds=60)
    chat=wait(lambda: next((r for r in local_read(driver,"/chat")["items"] if r["question"]==question),None),"real local chat saved")
    chat_refs=citation_check(chat["result"])
    driver.click(text_element(driver,".chat-exchange[open] summary","對照仿單原文"))
    wait(lambda: driver.execute("return Array.from(document.querySelectorAll('.chat-exchange[open] details[open] blockquote')).some(e=>e.innerText.includes('SYNTHETIC-E2E-5'));"),"chat source citation visible")
    snapshot(driver,out,"core-chat-citation")
    check(driver,checks,"local-chat-source-save",chat_id=chat["id"],citations=chat_refs)
    failure_question="測試一次失敗，請說明合成資料限制。"
    driver.fill(driver.find('textarea[aria-label="用藥問題"]'),failure_question);driver.click(button(driver,"送出"))
    body_has(driver,"系統這次沒能整理出可用內容。",seconds=60)
    if driver.execute("return document.querySelector('textarea[aria-label=\"用藥問題\"]').value;")!=failure_question: raise AssertionError("Existing failed-chat draft preservation regressed")
    driver.execute("location.hash='jobs';")
    retry=button(driver,"使用原輸入重試")
    failed_jobs=[j for j in local_read(driver,"/jobs")["items"] if j["status"]=="failed"]
    if len(failed_jobs)!=1 or failed_jobs[0]["kind"]!="chat": raise AssertionError("Expected exactly one deliberate synthetic chat failure")
    failed_id=failed_jobs[0]["id"]
    snapshot(driver,out,"core-failure-recovery")
    driver.click(retry);body_has(driver,"已使用原輸入重新排入處理，進度會自動更新。")
    recovered=wait(lambda: next((r for r in local_read(driver,"/chat")["items"] if r["question"]==failure_question),None),"same-input fake provider recovery",seconds=60)
    job=local_read(driver,"/jobs/"+failed_id)
    if job["id"]!=failed_id or job["status"]!="succeeded" or job["attempts"]!=2: raise AssertionError("Recovery did not reuse the failed job with exactly one retry")
    driver.execute("location.hash='chat';");body_has(driver,failure_question)
    check(driver,checks,"local-failed-job-recovery",job_id=failed_id,attempts=job["attempts"],recovered_chat_id=recovered["id"],scope="Existing local synthetic fail-once provider; no real AI retry")
    driver.click(wait(lambda: driver.find('button[aria-label="登出"]'),"logout control"))
    driver.click(button(driver,"本機使用者"));body_has(driver,"今天的用藥日常")
    driver.execute("location.hash="+json.dumps(record_hash)+";")
    wait(lambda: driver.find('.question-complete[aria-label="理解測驗完成"]'),"saved completion after logout/login")
    readback=next(r for r in local_read(driver,"/learning")["items"] if r["id"]==learning["id"])
    if readback["answers"]!=expected: raise AssertionError("Quiz answers changed after logout/login")
    if not any(r["id"]==chat["id"] for r in local_read(driver,"/chat")["items"]): raise AssertionError("Chat missing after logout/login")
    if not any(r["id"]==med["id"] for r in local_read(driver,"/medications")["items"]): raise AssertionError("Medication missing after logout/login")
    if not any(r["id"]==schedules[0]["id"] and r["times"]==["08:00","20:00"] for r in local_read(driver,"/schedules")["items"]): raise AssertionError("Schedule changed after logout/login")
    snapshot(driver,out,"core-login-readback")
    check(driver,checks,"local-logout-login-readback",medication_present=True,quiz_answers_exact=True,chat_present=True,schedule_times_exact=True)
    details["service_worker_after"]=service_worker_state(driver,checks,"real-service-worker-private-cache-exclusion")
    details["long_presentation"]=long_presentation(driver,out,checks)
    details["local_records"]={"medication_id":med["id"],"learning_id":learning["id"],"chat_id":chat["id"],"recovered_chat_id":recovered["id"],"failed_job_id":failed_id,"saved_answer_ids":list(expected)}
    return details


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["probe","core"], default="probe")
    parser.add_argument("--base-url", default="http://127.0.0.1:5190")
    parser.add_argument("--driver-url", default="http://127.0.0.1:9515")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    args=parser.parse_args(); base, endpoint=loopback(args.base_url),loopback(args.driver_url)
    if not re.fullmatch(r"[0-9a-f]{40}",args.source_sha): parser.error("--source-sha must be a full Git SHA")
    out=args.output.resolve(); out.mkdir(parents=True,exist_ok=True)
    if (out/"receipt.json").exists(): raise RuntimeError("Refusing to overwrite an existing native Safari receipt")
    driver=WebDriver(endpoint); began=utc(); checks=[]; details={}; success=False; failure=None; cleanup=None
    try:
        if platform.system()!="Darwin": raise RuntimeError("Native Safari requires macOS; no WebKit substitution is permitted")
        binary=Path("/usr/bin/safaridriver")
        if not binary.is_file(): raise RuntimeError("Apple /usr/bin/safaridriver is missing")
        actual=subprocess.check_output(["git","rev-parse","HEAD"],cwd=Path(__file__).resolve().parents[1],text=True).strip()
        if actual!=args.source_sha: raise RuntimeError("Source SHA does not match checkout HEAD")
        details["driver_path"]=str(binary)
        details["driver_version"]=subprocess.check_output([str(binary),"--version"],text=True).strip()
        details["readiness"]=wait_readiness(driver,base)
        details["driver_status"]=details["readiness"]["driver_status"]
        caps=driver.start();details["capabilities"]={k:v for k,v in caps.items() if k in {"browserName","browserVersion","platformName","pageLoadStrategy","acceptInsecureCerts","strictFileInteractability","unhandledPromptBehavior"}}
        checks.append({"id":"native-safari-session","status":"passed"})
        details["window_rect"]=driver.call("POST","/window/rect",{"width":1366,"height":1000})
        details.update((core if args.mode=="core" else probe)(driver,base,out,checks))
        required={"probe-shell","probe-upload"}
        if args.mode=="core":required.update({"core-product-review","core-source-citation","core-wrong-answer","core-quiz-complete","core-reminder-invalid","core-reminder-saved","core-chat-citation","core-failure-recovery","core-login-readback","core-long-original","core-long-complete"})
        complete={e["checkpoint"] for e in driver.evidence if e["status"]=="PASS"}
        if required-complete:raise AssertionError("Required evidence checkpoints missing: "+",".join(sorted(required-complete)))
        details["mandatory_evidence_checkpoints"]=sorted(required);success=True
    except Exception as exc:
        failure={"type":type(exc).__name__,"message":str(exc)[:2400]}; snapshot(driver,out,"failure",required=False)
    finally:
        try: driver.close();cleanup="session_deleted"
        except Exception as exc:cleanup="delete_failed:"+str(exc)[:300];success=False
    receipt={"schema":"native-safari-desktop/v2","mode":args.mode,"status":"PASS" if success else "FAIL","passed":success,"started_at_utc":began,"completed_at_utc":utc(),"source_sha":args.source_sha,"script_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"macos":platform.mac_ver()[0],"base_url":base,"driver_url":endpoint,"checks":checks,"details":details,"diagnostics":driver.diagnostics,"failure":failure,"cleanup":cleanup,"commands":driver.commands,"evidence":driver.evidence,"artifacts":[{"path":p.name,"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"bytes":p.stat().st_size} for p in sorted(out.iterdir()) if p.is_file()],"coverage_limit":"Native Safari named core workflow when mode=core, otherwise session/login/file probe; not all135Playwright cases. Native file readability and in-memory frontend fallback are separate. Long public wording uses explicit frontend-only fetch fixture; short synthetic quiz/chat/schedule persistence uses actual local API. No OS picker, camera, mobile Safari, push delivery, real OCR/AI or production-data claims.","network_scope":"Client URLs validated127.0.0.1; app server must use existing synthetic provider+Node network guard. Native browser OS background traffic is not globally firewalled by this script.","product_AI_calls":0,"production_credentials_or_health_data":False}
    (out/"receipt.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"passed":success,"mode":args.mode,"checks":len(checks),"receipt":str(out/"receipt.json"),"failure":failure},ensure_ascii=False))
    return 0 if success else 1

if __name__=="__main__":raise SystemExit(main())
