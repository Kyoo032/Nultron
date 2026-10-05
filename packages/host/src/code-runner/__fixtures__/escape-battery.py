# Escape attempts. Each prints one line:  Exx | label | RESULT
# RESULT is "ESCAPED: <evidence>" when the attempt reached something it must not, or "blocked: <reason>".
import asyncio, sys, traceback

RES = []

def rec(eid, label, status, detail=""):
    line = f"{eid} | {label} | {status}{': ' + str(detail)[:150] if detail else ''}"
    RES.append(line)
    print(line)

def attempt(eid, label, fn, escaped_if=lambda v: True):
    try:
        v = fn()
        if escaped_if(v):
            rec(eid, label, "ESCAPED", repr(v))
        else:
            rec(eid, label, "blocked", repr(v))
    except BaseException as e:  # noqa
        rec(eid, label, "blocked", f"{type(e).__name__}: {e}")

def truthy_not_undefined(v):
    return v is not None and repr(v) != "undefined" and repr(v) != "None"

import js
attempt("E01", "import js; js.process", lambda: js.process, truthy_not_undefined)
attempt("E02", "import js; js.require", lambda: js.require, truthy_not_undefined)
attempt("E03", "js.globalThis / js.fetch", lambda: (js.globalThis, js.fetch), lambda v: any(truthy_not_undefined(x) for x in v))
attempt("E03b", "dir(js) size", lambda: len(dir(js)), lambda v: v > 40)

import pyodide_js
attempt("E04", "pyodide_js._module", lambda: type(pyodide_js._module).__name__, lambda v: True)
attempt("E04b", "pyodide_js._module.FS / NODEFS", lambda: (type(pyodide_js._module.FS).__name__, type(pyodide_js._module.NODEFS).__name__), lambda v: True)

from pyodide.code import run_js
attempt("E05", "pyodide.code.run_js('typeof process')", lambda: run_js("typeof process"), lambda v: v != "undefined")
attempt("E05b", "run_js('globalThis.process.env')", lambda: run_js("Object.keys(globalThis.process.env).join(',')"), lambda v: True)
attempt("E05c", "run_js(require child_process whoami)", lambda: run_js("process.getBuiltinModule('child_process').execSync('whoami').toString()"), lambda v: True)

attempt("E06", "pyodide_js.registerJsModule.constructor('return typeof process')()  (Function ctor via any sync JS fn)",
        lambda: pyodide_js.registerJsModule.constructor("return typeof process")(), lambda v: v != "undefined")
attempt("E06b", "Function ctor -> getBuiltinModule fs read win.ini/hosts",
        lambda: pyodide_js.registerJsModule.constructor("return process.getBuiltinModule('fs').readFileSync(process.platform==='win32'?'C:/Windows/win.ini':'/etc/hosts','utf8').slice(0,40)")(), lambda v: True)
attempt("E06c", "Function ctor -> import('node:child_process') promise",
        lambda: type(pyodide_js.registerJsModule.constructor("return import('node:child_process')")()).__name__, lambda v: True)
attempt("E06d", "indirect eval via Function ctor -> eval('typeof process')",
        lambda: pyodide_js.registerJsModule.constructor("return (0,eval)('typeof process')")(), lambda v: v != "undefined")

from pyodide.ffi import JsProxy, to_js, create_proxy
attempt("E07", "pyodide.ffi reach globalThis (to_js/JsProxy)", lambda: (JsProxy.__name__, to_js({"a": 1}).constructor.name), lambda v: False)

import os
attempt("E08", "os.system('whoami')", lambda: os.system("whoami"), lambda v: v == 0)
def sp():
    import subprocess
    return subprocess.run(["whoami"], capture_output=True, text=True)
attempt("E09", "subprocess.run(['whoami'])", sp, lambda v: True)
attempt("E10", "open('C:/Windows/win.ini')", lambda: open("C:/Windows/win.ini").read()[:30], lambda v: True)
attempt("E10b", "open('/etc/hosts')", lambda: open("/etc/hosts").read()[:30], lambda v: True)
attempt("E10c", "os.listdir('/') (virtual root)", lambda: os.listdir("/"), lambda v: False)
def sock():
    import socket
    return socket.create_connection(("example.com", 80), timeout=3)
attempt("E11", "socket.create_connection(example.com:80)", sock, lambda v: True)
def sock2():
    import socket, time
    s = socket.socket(); s.setblocking(False)
    try:
        s.connect(("127.0.0.1", __LISTENER_PORT__))
    except BlockingIOError:
        pass
    time.sleep(0.05)
    return "connect issued to loopback listener (check parent log for HIT)"
attempt("E11b", "socket connect to loopback listener (parent observes HIT)", sock2, lambda v: True)
def pf():
    from pyodide.http import pyfetch
    return pyfetch
attempt("E12", "from pyodide.http import pyfetch (import only)", pf, lambda v: False)
def urlo():
    import urllib.request
    return urllib.request.urlopen("https://example.com", timeout=3).status
attempt("E13", "urllib.request.urlopen(https://example.com)", urlo, lambda v: True)
def ct():
    import ctypes
    return ctypes.CDLL(None) if hasattr(ctypes, "CDLL") else ctypes
attempt("E14", "import ctypes (+ CDLL(None))", ct, lambda v: False)
attempt("E15", "os.environ keys", lambda: sorted(os.environ.keys()), lambda v: any(k for k in v if "KEY" in k or "SECRET" in k or "WRAP" in k))
attempt("E15b", "os.environ WRAP_KEY_TEST", lambda: os.environ.get("WRAP_KEY_TEST"), lambda v: v is not None)
attempt("E16", "pyodide_js.mountNodeFS('/mnt', host dir)",
        lambda: (pyodide_js.mountNodeFS("/mnt", "C:/Windows" if sys.platform != "linux" else "/etc"), os.listdir("/mnt")[:3]), lambda v: True)
attempt("E17", "FS.mount(NODEFS) via _module",
        lambda: (os.makedirs("/m2", exist_ok=True), pyodide_js._module.FS.mount(pyodide_js._module.NODEFS, to_js({"root": "C:/Windows"}, dict_converter=__import__("js").Object.fromEntries), "/m2"), os.listdir("/m2")[:3]), lambda v: True)
def lp():
    return pyodide_js.loadPackage("scipy")
attempt("E18", "pyodide_js.loadPackage('scipy') (network/CDN)", lp, lambda v: False)
def mp():
    import micropip  # noqa
    return "micropip importable"
attempt("E19", "import micropip", mp, lambda v: True)
def op():
    from pyodide.http import open_url
    return open_url("https://example.com").read()[:20]
attempt("E20", "pyodide.http.open_url(https://example.com)", op, lambda v: True)
attempt("E21", "js.fetch via sys.modules['js']", lambda: sys.modules["js"].fetch, truthy_not_undefined)
print("DONE", len(RES))
