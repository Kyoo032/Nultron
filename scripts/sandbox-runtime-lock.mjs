// What scripts/sandbox-runtime.lock.json may say, and how it relates to the pyodide lockfile that ships in the npm
// package. Pure functions: no file system, no network. Used by scripts/build-sandbox-runtime.mjs, which re-exports them.

const SHA256 = /^[0-9a-f]{64}$/;
/** A name the build may join under its output folder: relative, no `..`, no backslash, no odd characters. */
const PLAIN_RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9@._+/-]+$/;

/** Where the Pyodide files and the wheels sit inside the built folder (the contract with the host's code-runner). */
export const PYODIDE_DIR = "vendor/pyodide";

/** Pyodide files copied verbatim from the npm package (the lockfile is trimmed, see `trimPyodideLock`). */
export const PYODIDE_CORE_FILES = ["pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide.mjs", "python_stdlib.zip"];
export const PYODIDE_LOCK_SOURCE = "pyodide-lock.json";
export const PYODIDE_PRELOAD = ["numpy", "pandas"];

/** Which files of each QuickJS package ship: the ESM and CJS entry points and the wasm, no maps or typings. */
export const QUICKJS_PACKAGES = [
  { name: "quickjs-emscripten-core", include: [/^package\.json$/, /^LICENSE$/, /^dist\/[^/]+\.(?:mjs|js)$/] },
  { name: "@jitl/quickjs-ffi-types", include: [/^package\.json$/, /^LICENSE$/, /^dist\/index\.(?:mjs|js)$/] },
  {
    name: "@jitl/quickjs-wasmfile-release-sync",
    include: [
      /^package\.json$/,
      /^LICENSE$/,
      /^dist\/(?:emscripten-module\.(?:mjs|wasm)|ffi\.(?:mjs|js)|index\.(?:mjs|js))$/,
    ],
  },
];

/** Plain code-unit order, so a manifest sorts the same on every platform and locale. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Every package `roots` needs, itself included, by walking `depends` in a pyodide lockfile. Sorted. */
export function dependencyClosure(pyodideLock, roots) {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    const entry = pyodideLock.packages[name];
    if (!entry) throw new Error(`package ${name} is not in the pyodide lockfile`);
    seen.add(name);
    for (const dep of entry.depends ?? []) visit(dep);
  };
  for (const root of roots) visit(root);
  return [...seen].sort(byCodeUnit);
}

/**
 * The pyodide lockfile cut down to the wheels that ship. Throws if a shipped file is not in the full
 * lockfile, or if a kept package depends on one that was cut (the guest would then trigger a lookup).
 */
export function trimPyodideLock(fullLock, shippedFileNames) {
  const keep = new Set(shippedFileNames);
  const packages = Object.fromEntries(
    Object.entries(fullLock.packages).filter(([, entry]) => keep.has(entry.file_name)),
  );
  const found = new Set(Object.values(packages).map((entry) => entry.file_name));
  const missing = [...keep].filter((file) => !found.has(file)).sort(byCodeUnit);
  if (missing.length > 0) {
    throw new Error(`shipped file(s) not in the pyodide lockfile: ${missing.join(", ")}`);
  }
  for (const [name, entry] of Object.entries(packages)) {
    for (const dep of entry.depends ?? []) {
      if (!(dep in packages)) throw new Error(`${name} depends on ${dep}, which is not shipped`);
    }
  }
  return { info: fullLock.info, packages };
}

/** Shape and pin checks on the lock file's content. Throws with the first problem. */
export function validateLock(lock) {
  const fail = (message) => {
    throw new Error(`sandbox-runtime.lock.json: ${message}`);
  };
  if (lock?.schema !== 1) fail("schema must be 1");
  const py = lock.pyodide;
  if (!py?.version || !py.python) fail("pyodide.version and pyodide.python are required");
  const cdn = `https://cdn.jsdelivr.net/pyodide/v${py.version}/full/`;
  if (py.cdn !== cdn) fail(`pyodide.cdn must be ${cdn}`);
  if (!Array.isArray(py.preload) || py.preload.length === 0) fail("pyodide.preload must be a non-empty list");
  const pinned = (where, entry) => {
    if (!entry?.file) fail(`${where}: file is required`);
    if (!PLAIN_RELATIVE.test(entry.file)) fail(`${where}: file must be a plain relative path`);
    if (!SHA256.test(entry.sha256 ?? "")) fail(`${where}: sha256 must be 64 lowercase hex characters`);
    if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) fail(`${where}: bytes must be a positive integer`);
  };
  pinned("pyodide.lockSource", py.lockSource);
  if (py.lockSource.file !== PYODIDE_LOCK_SOURCE) fail(`pyodide.lockSource.file must be ${PYODIDE_LOCK_SOURCE}`);
  const core = py.core ?? [];
  if (core.map((entry) => entry.file).join() !== PYODIDE_CORE_FILES.join()) {
    fail(`pyodide.core must list exactly ${PYODIDE_CORE_FILES.join(", ")}`);
  }
  for (const entry of core) pinned(`pyodide.core ${entry.file}`, entry);
  if (!Array.isArray(py.wheels) || py.wheels.length === 0) fail("pyodide.wheels must be a non-empty list");
  const seen = new Set();
  for (const wheel of py.wheels) {
    pinned(`pyodide.wheels ${wheel.name}`, wheel);
    if (wheel.file.includes("/")) fail(`pyodide.wheels ${wheel.name}: file must be a bare file name`);
    if (!wheel.name || !wheel.version) fail(`pyodide.wheels ${wheel.file}: name and version are required`);
    if (wheel.url !== `${cdn}${wheel.file}`) fail(`pyodide.wheels ${wheel.name}: url must be ${cdn}${wheel.file}`);
    if (seen.has(wheel.file)) fail(`pyodide.wheels: duplicate file ${wheel.file}`);
    seen.add(wheel.file);
  }
  const names = (lock.quickjs?.packages ?? []).map((pkg) => pkg.name);
  if (names.join() !== QUICKJS_PACKAGES.map((pkg) => pkg.name).join()) {
    fail(`quickjs.packages must list exactly ${QUICKJS_PACKAGES.map((pkg) => pkg.name).join(", ")}`);
  }
  for (const pkg of lock.quickjs.packages) {
    if (!pkg.version) fail(`quickjs ${pkg.name}: version is required`);
    if (!Array.isArray(pkg.files) || pkg.files.length === 0)
      fail(`quickjs ${pkg.name}: files must be a non-empty list`);
    // The shape and path of every entry come first: a hostile path is refused for what it is, whichever file
    // it replaced, and only then do the rules about which files must be there apply.
    for (const entry of pkg.files) pinned(`quickjs ${pkg.name} ${entry?.file}`, entry);
    if (!pkg.files.some((entry) => entry.file === "package.json")) fail(`quickjs ${pkg.name}: package.json must ship`);
    if (!pkg.files.some((entry) => entry.file === "LICENSE")) fail(`quickjs ${pkg.name}: LICENSE must ship`);
  }
  validateLicenses(lock, fail);
  return lock;
}

/**
 * The `licenses` section: the license of every component the notices file lists. Pyodide and CPython carry no
 * license file in what ships, so each names a committed text (`file`, bare name in scripts/sandbox-licenses/) and
 * pins the sha256 of its text; every wheel needs an entry, and nothing else may have one.
 */
function validateLicenses(lock, fail) {
  const lic = lock.licenses;
  if (!lic || typeof lic !== "object") fail("licenses is required: the license of every shipped component");
  for (const key of ["pyodide", "cpython"]) {
    const entry = lic[key];
    if (typeof entry?.license !== "string" || entry.license.trim() === "") fail(`licenses.${key}.license is required`);
    if (!/^https:\/\/\S+$/.test(entry.homepage ?? "")) fail(`licenses.${key}.homepage must be an https URL`);
    if (!/^(?!\.)[A-Za-z0-9._+-]+$/.test(entry.file ?? "")) fail(`licenses.${key}.file must be a bare file name`);
    if (!SHA256.test(entry.sha256 ?? "")) fail(`licenses.${key}.sha256 must be 64 lowercase hex characters`);
  }
  const wheels = lic.wheels ?? {};
  const shipped = lock.pyodide.wheels.map((wheel) => wheel.name);
  const missing = shipped.filter((name) => !(name in wheels)).sort(byCodeUnit);
  if (missing.length > 0) {
    fail(`licenses.wheels has no entry for ${missing.join(", ")}: add the license each of them is distributed under`);
  }
  const extra = Object.keys(wheels)
    .filter((name) => !shipped.includes(name))
    .sort(byCodeUnit);
  if (extra.length > 0) fail(`licenses.wheels lists ${extra.join(", ")}, which no shipped wheel is`);
  for (const [name, license] of Object.entries(wheels)) {
    if (typeof license !== "string" || license.trim() === "") fail(`licenses.wheels ${name}: license is required`);
  }
}

/** The wheels must be exactly the dependency closure of what the child preloads, with the lockfile's own hashes. */
export function checkLockAgainstPyodide(lock, pyodideLock) {
  const py = lock.pyodide;
  if (pyodideLock.info?.python !== py.python) {
    throw new Error(`pyodide lockfile is for python ${pyodideLock.info?.python}, the lock pins ${py.python}`);
  }
  const closure = dependencyClosure(pyodideLock, py.preload);
  const pinned = py.wheels.map((wheel) => wheel.name).sort(byCodeUnit);
  if (closure.join() !== pinned.join()) {
    throw new Error(
      `pinned wheels (${pinned.join(", ")}) are not the closure of ${py.preload.join(", ")} (${closure.join(", ")})`,
    );
  }
  for (const wheel of py.wheels) {
    const entry = pyodideLock.packages[wheel.name];
    if (entry.file_name !== wheel.file) {
      throw new Error(`wheel ${wheel.name}: lock pins ${wheel.file}, the pyodide lockfile says ${entry.file_name}`);
    }
    if (entry.sha256 !== wheel.sha256) {
      throw new Error(`wheel ${wheel.name}: sha256 differs from the pyodide lockfile (${entry.sha256})`);
    }
  }
}
