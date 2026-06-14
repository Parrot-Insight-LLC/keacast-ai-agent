# CLAUDE.md — keacast-ai-agent

Project-level guidance for Claude Code. Inherits the global engineering standards in
`C:\Users\garyr\Documents\Workflows\memory\engineering-standards.md` (the IEOS). This file covers only
what is **specific and real** about this repository.

> IEOS pipeline: model before changing, smallest safe change, state risks. After finishing, route
> learnings to `Documents\Workflows\memory\` via `Documents\Workflows\08-learning\institutional-memory.md`.

---

## Project Overview

Keacast AI Agent API — a Node.js/Express service that fronts **Azure OpenAI** to provide a financial
assistant over Keacast data. It exposes chat and summarization endpoints that share a **unified,
session-based conversation history**, plus a Redis-backed **context cache**. An LLM **tool/function-calling
layer** (`tools/`) lets the model call Keacast functions. Owner: Parrot Insight LLC
(`github.com/Parrot-Insight-LLC/keacast-ai-agent`, default branch `master`).

## Tech Stack (verified from `package.json` and code)

- **Runtime:** Node.js `>=16`, Express 4. Entry point is **`server.js`** (`app.js` builds the Express app).
- **AI:** Azure OpenAI (via `axios` to the Azure endpoint; config in env).
- **Data:** **MySQL via `mysql2/promise`** — a connection **pool** in `services/db.js` using **parameterized** `pool.execute(sql, params)`. (Contrast with `keacast-api`, which uses raw concatenated SQL — keep this repo's parameterized style.)
- **Cache:** Redis via `ioredis` (`services/redisService.js`, `services/contextCache.service.js`).
- **Auth:** JWT (`jsonwebtoken`) + `bcryptjs`; `middleware/authMiddleware.js`. Secret from `JWT_SECRET`.
- **Hardening:** `helmet` (`securityHeaders`), `express-rate-limit` + `rate-limiter-flexible`, CORS lock-down, `requestId` (uuid), `pino`/`pino-http` + `morgan` logging.

## Common Commands

```bash
npm install
npm run dev          # nodemon server.js (development)
npm start            # node server.js
npm run prod         # NODE_ENV=production node server.js
npm run deploy:check # prints whether key env vars are set
```

> **`npm test` is a stub** — it runs `echo "Error: no test specified" && exit 0`. There are **no real
> automated tests**. `test-context-cache.js` and `test-unified-history.js` (via `npm run test:history`) are
> ad-hoc manual scripts, not a suite. Do not present `npm test` as a passing test run. Adding a real test
> suite is a known gap.

## Folder Structure

```
server.js / app.js     # entry + Express app (middleware order matters — see below)
controllers\           # authController, cacheController, openaiController
routes\                # authRoutes (/api/auth), openaiRoutes (/api/agent), cacheRoutes (/api/cache)
services\              # db (mysql2 pool), redisService, contextCache.service, openaiService,
                       #   accounts.service, transactions.service
middleware\            # authMiddleware, errorHandler, logging, requestId, securityHeaders,
                       #   rateLimit.redis (prod), rateLimit.simple (dev)
tools\                 # functionMap.js, keacast_functions_schemas.json, keacast_tool_layer.js (LLM tool layer)
utils\                 # tokenUtils.js
```

Key endpoints (from `app.js`): `GET /health`, `POST /api/auth/login`, `POST /api/agent/chat`,
`POST /api/agent/summarize`, `DELETE /api/agent/clear-history`, and the `/api/cache/*` admin/cache routes.

## Configuration (env — see `deployment.env.example`)

Required: `NODE_ENV`, `PORT` (default 5001), `ALLOWED_ORIGINS`, `AZURE_OPENAI_ENDPOINT`,
`AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_API_KEY`, `REDIS_HOST`, `REDIS_PORT`,
`REDIS_PASSWORD`, `REDIS_TLS`, `JWT_SECRET`, and DB vars used by `services/db.js`:
`DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`, `DB_PORT`.

## Deployment

- **Azure App Service** (`*.azurewebsites.net`, region eastus2) via **GitHub Actions**
  (`.github/workflows/master_keacast-ai.yml`). This is **different** from `keacast-api`'s GitLab→AKS path —
  do not apply the AKS playbook here.
- Repo-local docs: `DEPLOYMENT_CHECKLIST.md`, `DEPLOYMENT_TROUBLESHOOTING.md`, `CONTEXT_CACHING.md`,
  `MARKDOWN_FORMATTING.md`. Read these before deploy/troubleshooting work.

## High-Risk Areas (preserve carefully; flag before changing)

1. **Middleware order in `app.js`.** `requestId → logging → securityHeaders → rate limiters → cors → body
   parsing → routes → 404 → errorHandler`. Reordering can disable security headers, rate limiting, or error
   handling. Change deliberately.
2. **Rate limiter is a manual toggle.** `app.js` imports `rateLimit.redis` (prod) with `rateLimit.simple`
   commented out. Ensure the correct one is active for the target environment.
3. **Secrets in environment.** Azure OpenAI key, `JWT_SECRET`, Redis password, DB password all come from env.
   Never commit a real `.env`; never log secret values. Confirm `.env` is gitignored.
4. **Production error/CORS behavior.** Errors must not leak stack traces in production (handled in `app.js`);
   CORS is locked to `ALLOWED_ORIGINS` in production. Preserve both.
5. **Parameterized SQL.** `services/db.js` uses `pool.execute(sql, params)`. **Never** switch to string
   concatenation. Every new query passes values as params.
6. **Unified conversation history + cache invalidation.** Chat and summarize share history per session/user,
   and `contextCache.service` caches LLM results in Redis. Cache invalidation routes exist for a reason —
   changing history or cache keys can serve stale or cross-user data. Review `CONTEXT_CACHING.md` first.

## Ask Before Doing (in addition to global rules)

- Changing auth (`authMiddleware`, JWT handling) or the rate-limiting strategy.
- Modifying the `tools/` LLM function layer or schemas (changes what the model can do).
- Changing cache keys, TTLs, or invalidation logic.
- Editing the GitHub Actions workflow or deployment config.

## Validation expectations

`npm run deploy:check` to confirm env wiring; manually exercise `/health` and an `/api/agent` endpoint.
Because there's no test suite, state explicit manual verification steps for any behavior change and record
outcomes in IEOS memory.
