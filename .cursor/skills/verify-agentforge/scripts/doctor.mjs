#!/usr/bin/env node
/**
 * Read-only: is this Nultron instance worth driving?
 * Usage:
 *   node .cursor/skills/verify-agentforge/scripts/doctor.mjs
 *       → local webdev at http://127.0.0.1:3000
 *   node .cursor/skills/verify-agentforge/scripts/doctor.mjs --desktop
 *       → packaged IPC host from Electron userData host-status.json:
 *         Windows: %APPDATA%/Nultron|Kemenkeu AI|AIHub Metranet/host-status.json
 *                  (legacy: %APPDATA%/@agentforge/desktop/host-status.json)
 *         Linux:   $XDG_CONFIG_HOME/Nultron|Kemenkeu AI|AIHub Metranet/host-status.json
 *                  or ~/.config/<same>/host-status.json
 *         macOS:   ~/Library/Application Support/Nultron|Kemenkeu AI|AIHub Metranet/host-status.json
 *   node …/doctor.mjs --base http://127.0.0.1:PORT
 *   PORT=3200 node …/doctor.mjs
 *   AGENTFORGE_VERIFY_URL=http://127.0.0.1:PORT node …/doctor.mjs
 *       → explicit loopback for **webdev only** (ignored with --desktop).
 *         Precedence: --base, then PORT, then AGENTFORGE_VERIFY_URL, then :3000.
 */
const WEBDEV_URL = "http://127.0.0.1:3000";
const desktopFlag = process.argv.includes("--desktop");

function fail(message, extra) {
  console.error(`verify-agentforge doctor: FAIL — ${message}`);
  if (extra) {
    console.error(extra);
  }
  process.exit(1);
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function portOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      return Number(parsed.port);
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return NaN;
  }
}

async function get(base, path) {
  const url = `${base}${path}`;
  const started = Date.now();
  const response = await fetch(url, { redirect: "manual" });
  const text = await response.text();
  return { url, status: response.status, ms: Date.now() - started, text };
}

function baseFromArgv() {
  const inline = process.argv.find((arg) => arg.startsWith("--base="));
  if (inline) {
    return inline.slice("--base=".length).trim();
  }
  const flag = process.argv.indexOf("--base");
  if (flag !== -1 && process.argv[flag + 1]) {
    return process.argv[flag + 1].trim();
  }
  const port = process.env.PORT?.trim();
  if (port && /^\d+$/.test(port)) {
    return `http://127.0.0.1:${port}`;
  }
  return "";
}

async function doctorWebdev() {
  // --base wins, then PORT (both resolved in baseFromArgv), then AGENTFORGE_VERIFY_URL, then :3000.
  const override = baseFromArgv() || process.env.AGENTFORGE_VERIFY_URL?.trim();
  const fromEnv = override;
  const BASE = (override || WEBDEV_URL).replace(/\/$/, "");
  const host = hostnameOf(BASE);
  if (host !== "127.0.0.1" && host !== "localhost") {
    fail(`refusing non-loopback URL ${BASE}. Drive loopback only.`);
  }
  if (portOf(BASE) !== 3000 && !fromEnv) {
    fail(`${BASE} is not the local webdev port. Webdev doctor is :3000 only.`);
  }

  let chat;
  let settings;
  try {
    chat = await get(BASE, "/chat");
  } catch (error) {
    fail(`GET ${BASE}/chat did not connect. Start \`npx pnpm@9.15.9 --filter @agentforge/web dev\` (local webdev on :3000; root \`pnpm dev\` also starts apps/portal, which exits without Postgres).`, String(error));
  }

  if (chat.status < 200 || chat.status >= 400) {
    fail(`GET /chat returned ${chat.status}`, chat.text.slice(0, 400));
  }

  try {
    settings = await get(BASE, "/api/v1/settings");
  } catch (error) {
    fail(`GET ${BASE}/api/v1/settings failed`, String(error));
  }

  if (settings.status !== 200) {
    fail(`GET /api/v1/settings returned ${settings.status}`, settings.text.slice(0, 400));
  }

  let payload;
  try {
    payload = JSON.parse(settings.text);
  } catch {
    fail("settings response was not JSON", settings.text.slice(0, 400));
  }

  const runtime = payload.runtime ?? "(missing)";
  const hasOpenai = Boolean(payload.hasOpenai);
  const openaiKeyFingerprint =
    typeof payload.openaiKeyFingerprint === "string" ? payload.openaiKeyFingerprint.trim() : "";
  const keyFingerprint = Boolean(
    hasOpenai && openaiKeyFingerprint.startsWith("sha256:") && openaiKeyFingerprint.length > "sha256:".length,
  );

  let models;
  try {
    models = await get(BASE, "/api/v1/models");
  } catch (error) {
    fail(`GET ${BASE}/api/v1/models failed`, String(error));
  }

  if (models.status !== 200) {
    fail(`GET /api/v1/models returned ${models.status}`, models.text.slice(0, 400));
  }

  let modelsPayload;
  try {
    modelsPayload = JSON.parse(models.text);
  } catch {
    fail("models response was not JSON", models.text.slice(0, 400));
  }

  const modesObj =
    modelsPayload.modes && typeof modelsPayload.modes === "object" && !Array.isArray(modelsPayload.modes)
      ? modelsPayload.modes
      : {};
  const modeKeys = Object.keys(modesObj);
  const modelsList = Array.isArray(modelsPayload.models) ? modelsPayload.models : [];
  const chatCount = modelsList.length;
  const hasTopLevelCuration =
    modelsPayload.curation != null &&
    (typeof modelsPayload.curation === "object" || typeof modelsPayload.curation === "boolean");
  const hasPerModelCuration = modelsList.some(
    (entry) => entry && typeof entry === "object" && ("bestFor" in entry || "tier" in entry || "curation" in entry),
  );
  const curation = Boolean(hasTopLevelCuration || hasPerModelCuration);

  let edit = { available: false };
  let editNote = "";
  try {
    const editRes = await get(BASE, "/api/v1/edit/doctor");
    if (editRes.status === 200) {
      try {
        const editPayload = JSON.parse(editRes.text);
        edit = {
          ffmpeg: editPayload.ffmpeg ?? null,
          asr: editPayload.asr ?? null,
        };
      } catch {
        editNote = "verify-agentforge doctor: note — GET /api/v1/edit/doctor was not JSON.";
      }
    } else {
      editNote = `verify-agentforge doctor: note — GET /api/v1/edit/doctor returned ${editRes.status}.`;
    }
  } catch {
    editNote = "verify-agentforge doctor: note — GET /api/v1/edit/doctor did not connect.";
  }

  let knowledgeStatus = 0;
  let knowledgeRetrievals = null;
  let knowledgeGraph = null;
  let knowledgeVerified = null;
  let knowledgeBackend = null;
  try {
    const knowledge = await get(BASE, "/api/v1/knowledge");
    knowledgeStatus = knowledge.status;
    try {
      const knowledgePayload = JSON.parse(knowledge.text);
      // Retrieved stage of the knowledge loop: chunks served to runs, all time. null on older builds.
      knowledgeRetrievals =
        typeof knowledgePayload.retrievals === "number" ? knowledgePayload.retrievals : null;
      // Graph stage: node / edge counts after a map run. null on builds before Phase 2.
      const graph = knowledgePayload.graph;
      knowledgeGraph =
        graph && typeof graph.nodes === "number" && typeof graph.edges === "number"
          ? { nodes: graph.nodes, edges: graph.edges }
          : null;
      // Verified stage: the last planted-fact self-check. null when it has never run.
      const verified = knowledgePayload.verified;
      knowledgeVerified = verified && typeof verified.ok === "boolean" ? verified.ok : null;
      // Which retrieval engine answers this desk. null on builds before Phase 3.
      const backend = knowledgePayload.backend;
      knowledgeBackend =
        backend && typeof backend.id === "string"
          ? {
              id: backend.id,
              selected: typeof backend.selected === "string" ? backend.selected : backend.id,
              available: backend.available === true,
              health: backend.health && typeof backend.health.ok === "boolean" ? backend.health.ok : null,
              outbox: typeof backend.outbox === "number" ? backend.outbox : null,
            }
          : null;
    } catch {
      knowledgeRetrievals = null;
      knowledgeGraph = null;
      knowledgeVerified = null;
      knowledgeBackend = null;
    }
  } catch {
    knowledgeStatus = 0;
  }

  // The host's gate verdict, trimmed to what a recipe asserts on. No endpoint, no message.
  const gate = payload.gateway && typeof payload.gateway === "object" ? payload.gateway : null;
  const gateway = gate
    ? {
        status: typeof gate.status === "string" ? gate.status : null,
        allowed: typeof gate.allowed === "boolean" ? gate.allowed : null,
        grace: typeof gate.grace === "boolean" ? gate.grace : null,
      }
    : null;

  const report = {
    ok: true,
    url: BASE,
    surface: "webdev",
    chatStatus: chat.status,
    runtime,
    hasOpenai,
    gateway,
    keyFingerprint,
    modeKeys,
    chatCount,
    curation,
    knowledge: knowledgeStatus === 200,
    knowledgeRetrievals,
    knowledgeGraph,
    knowledgeVerified,
    knowledgeBackend,
    gatewayName: typeof payload.gatewayName === "string" ? payload.gatewayName : undefined,
    // This is THIS shell's env, not the server's — the host does not expose its
    // data dir over HTTP. On an isolated drive the server's dir is whatever you
    // passed it, not what doctor prints here.
    dataDirThisShell: process.env.AGENTFORGE_DATA_DIR || "unset in this shell (webdev default: <repo>/data)",
    sqliteHint: "data/agentforge.sqlite under AGENTFORGE_DATA_DIR or repo data/",
    edit,
  };

  console.log(JSON.stringify(report, null, 2));
  console.log("");
  if (editNote) {
    console.log(editNote);
  }
  if (runtime === "stub") {
    console.log("verify-agentforge doctor: OK — stub runtime. Safe for Chat send without a live gateway.");
  } else if (runtime === "ai" && hasOpenai) {
    console.log(
      "verify-agentforge doctor: OK — live runtime (a provider key is saved). Do not treat Chat send or studio generate as stub proof. Settings view and needs-key checks are still valid only when those UI states actually appear.",
    );
  } else if (runtime === "ai") {
    console.log(
      "verify-agentforge doctor: OK — live runtime, but no key is saved, so the gateway gate is closed and the desk shows onboarding. Drive the gate and onboarding recipes, not Chat.",
    );
  } else {
    console.log(
      `verify-agentforge doctor: OK — unexpected runtime ${runtime}. Read GET /api/v1/settings before driving.`,
    );
  }
}

if (desktopFlag) {
  fail("the desktop app is retired (2026-10-14); run doctor against webdev instead.");
} else {
  await doctorWebdev();
}
