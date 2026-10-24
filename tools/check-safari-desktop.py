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
        self.url = loopback(url); self.session = ""; self.commands = []
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
        if isinstance(value, dict) and value.get("error"):
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
    def find(self, selector: str, using="css selector"):
        return self.call("POST", "/element", {"using": using, "value": selector})
    def click(self, element):
        self.execute("arguments[0].scrollIntoView({block:'center'});", [element])
        return self.call("POST", "/element/" + element[ELEMENT] + "/click", {})
    def keys(self, element, text: str):
        return self.call("POST", "/element/" + element[ELEMENT] + "/value", {"text": text, "value": list(text)})
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


def snapshot(driver, out: Path, label: str):
    if not driver.session: return []
    paths = []
    try:
        encoded = driver.call("GET", "/screenshot")
        p = out/(label+".png"); p.write_bytes(base64.b64decode(encoded)); paths.append(p.name)
    except Exception: pass
    try:
        html = driver.execute("const root=document.documentElement.cloneNode(true);root.querySelectorAll('input').forEach(e=>{e.removeAttribute('value');if(e.type==='password')e.textContent='';});return root.outerHTML;")
        p = out/(label+".html"); p.write_text(html, encoding="utf-8"); paths.append(p.name)
    except Exception: pass
    return paths


def upload(driver, path: Path, checks):
    element = wait(lambda: driver.find('input[type="file"]'), "photo input")
    try:
        driver.keys(element, str(path.resolve()))
        kind = "native-input-sendkeys"
        checks.append({"id": "native-file-input", "status": "passed", "scope": "WebDriver file input selection, not OS picker interaction"})
    except DriverError as exc:
        # This fallback remains a distinct coverage claim, never native file picker coverage.
        checks.append({"id": "native-file-input", "status": "driver-limited", "driver_error": exc.code, "detail": str(exc), "scope": "No native file selection pass claimed"})
        driver.execute("const input=arguments[0],bytes=new Uint8Array(arguments[1]);const dt=new DataTransfer();dt.items.add(new File([bytes],'synthetic-safari.png',{type:'image/png'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));", [element, list(path.read_bytes())])
        kind = "dom-file-datatransfer"
    wait(lambda: driver.execute("const e=document.querySelector('.capture-preview img');return !!e&&e.complete&&e.naturalWidth>0;"), "synthetic photo preview")
    return kind


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
    method = upload(driver,image,checks)
    checks.append({"id": "frontend-file-preview", "status": "passed", "method": method, "os_picker_tested": False, "real_photo_or_AI": False})
    snapshot(driver,out,"probe-upload")
    return {"upload_method": method, "user_agent": driver.execute("return navigator.userAgent;"), "url": driver.call("GET", "/url")}


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=["probe"], default="probe")
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
        details.update(probe(driver,base,out,checks));success=True
    except Exception as exc:
        failure={"type":type(exc).__name__,"message":str(exc)[:2400]}; snapshot(driver,out,"failure")
    finally:
        try: driver.close();cleanup="session_deleted"
        except Exception as exc:cleanup="delete_failed:"+str(exc)[:300];success=False
    receipt={"schema":"native-safari-desktop-probe/v1","mode":args.mode,"status":"PASS" if success else "FAIL","passed":success,"started_at_utc":began,"completed_at_utc":utc(),"source_sha":args.source_sha,"script_sha256":hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),"macos":platform.mac_ver()[0],"base_url":base,"driver_url":endpoint,"checks":checks,"details":details,"failure":failure,"cleanup":cleanup,"commands":driver.commands,"artifacts":[{"path":p.name,"sha256":hashlib.sha256(p.read_bytes()).hexdigest(),"bytes":p.stat().st_size} for p in sorted(out.iterdir()) if p.is_file()],"coverage_limit":"Native Safari probe only, not all135Playwright cases; no OS picker, camera, mobile Safari, push, real OCR/AI or production-data claims.","network_scope":"Client URLs validated127.0.0.1; app server must use existing synthetic provider+Node network guard. Native browser OS background traffic is not globally firewalled by this script.","product_AI_calls":0,"production_credentials_or_health_data":False}
    (out/"receipt.json").write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"passed":success,"mode":args.mode,"checks":len(checks),"receipt":str(out/"receipt.json"),"failure":failure},ensure_ascii=False))
    return 0 if success else 1

if __name__=="__main__":raise SystemExit(main())
