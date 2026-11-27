# Nultron Public API (F5a)

A versioned, key-authenticated REST API for calling desk agents. Guardrails, quota and
audit behave exactly as on the web — every endpoint below reuses the desk's own run,
knowledge, media and usage paths.

- Base path: `/api/public/v1` — plus the OpenAI facade at `/v1/chat/completions`.
- Auth: `Authorization: Bearer nk_live_…`. Keys are created in **Settings → Advanced → API keys**
  (`GET/POST /api/v1/api-keys`), shown **once**, stored as SHA-256 only, scoped to agents,
  optionally rate-limited and expiring.
- Enablement: `AGENTFORGE_PUBLIC_API=on` (default off).
- Errors: `{ "error": { "code", "message" } }`; `401 invalid_api_key`, `403 forbidden`,
  `429 rate_limited` (with `Retry-After`), `404 not_found`.
- OpenAPI: `GET /api/public/v1/openapi.json` (OpenAPI 3.1).

## Endpoints

| Method & path | What it does |
| --- | --- |
| `GET /api/public/v1/agents` | Agents the key may call |
| `POST /api/public/v1/agents/:agentId/messages` | Run an agent — sync JSON, or SSE with `Accept: text/event-stream` |
| `POST /api/public/v1/agents/:agentId/jobs` | Async run; result sealed until read |
| `GET /api/public/v1/jobs/:id` | Job status + result (sealed at rest) |
| `GET/POST /api/public/v1/threads` | List / open threads |
| `GET /api/public/v1/threads/:id` | Thread + messages |
| `POST /api/public/v1/knowledge/ingest` | Index pasted text into desk knowledge |
| `GET /api/public/v1/knowledge/search?query=` | Retrieve knowledge chunks |
| `POST /api/public/v1/files` | Upload a file (base64) |
| `GET /api/public/v1/files/:id` | Download (range-supported) |
| `GET /api/public/v1/usage?range=` | Desk usage |
| `POST /v1/chat/completions` | OpenAI-compatible facade; `model` = agent id |

## curl examples

```bash
export NK="nk_live_…"            # the key shown once at creation
export BASE="https://<desk>"     # e.g. https://app.nultron-ai.xyz or http://127.0.0.1:3000

# List the agents this key can call
curl -s "$BASE/api/public/v1/agents" -H "Authorization: Bearer $NK"

# Sync run
curl -s "$BASE/api/public/v1/agents/<agentId>/messages" \
  -H "Authorization: Bearer $NK" -H "Content-Type: application/json" \
  -d '{"content":"Summarise this week'"'"'s sales."}'

# SSE stream
curl -N "$BASE/api/public/v1/agents/<agentId>/messages" \
  -H "Authorization: Bearer $NK" -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" -d '{"content":"Draft the report."}'

# Async job
JOB=$(curl -s "$BASE/api/public/v1/agents/<agentId>/jobs" \
  -H "Authorization: Bearer $NK" -H "Content-Type: application/json" \
  -d '{"content":"Analyse the attachment."}' | jq -r .id)
curl -s "$BASE/api/public/v1/jobs/$JOB" -H "Authorization: Bearer $NK"

# Knowledge ingest + search
curl -s "$BASE/api/public/v1/knowledge/ingest" \
  -H "Authorization: Bearer $NK" -H "Content-Type: application/json" \
  -d '{"name":"Returns policy","text":"Refunds are processed within 14 days…"}'
curl -s "$BASE/api/public/v1/knowledge/search?query=refund%20window" \
  -H "Authorization: Bearer $NK"

# File upload (base64) and download
curl -s "$BASE/api/public/v1/files" -H "Authorization: Bearer $NK" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"logo.png\",\"type\":\"image/png\",\"data\":\"$(base64 -w0 logo.png)\"}"
curl -s "$BASE/api/public/v1/files/<fileId>" -H "Authorization: Bearer $NK" -o out.bin

# Usage
curl -s "$BASE/api/public/v1/usage?range=30d" -H "Authorization: Bearer $NK"

# OpenAI-compatible
curl -s "$BASE/v1/chat/completions" -H "Authorization: Bearer $NK" \
  -H "Content-Type: application/json" \
  -d '{"model":"<agentId>","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

## Notes

- A key scoped to `["*"]` reaches every agent; an explicit id list is enforced on every
  agent-scoped route with `403 forbidden`.
- Job results are sealed at rest (AES-256-GCM, same envelope as settings) and are readable
  only by the key that created the job.
- Key-started runs carry a **service identity** (`apikey-<key id>`), never the owner's —
  they cannot approve pending actions.
- Full per-key limit policies land in F9; today each key has one requests/minute bucket.
