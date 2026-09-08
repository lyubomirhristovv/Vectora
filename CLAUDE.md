# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Vectora is a self-hosted Azure Service Bus explorer (lightweight Service Bus Explorer alternative). Two projects in one repo, built and shipped together as a single container:

- `src/Vectora.Api` — .NET 10 minimal-API backend (also serves the built SPA from `wwwroot`).
- `src/Vectora.Client` — React 18 + TypeScript + Vite + Tailwind frontend, Monaco for message editing.

## Common commands

Backend (from `src/Vectora.Api`):
- `dotnet run` — runs on `http://localhost:5244` (see `Properties/launchSettings.json`). `ASPNETCORE_ENVIRONMENT=Development`.
- `dotnet ef migrations add <Name>` — add an EF Core migration. Migrations live in `src/Vectora.Api/Migrations/` and are auto-applied at startup (`db.Database.Migrate()` in `Program.cs`), so do not call `database update` manually unless you're working outside the app.
- `dotnet build` from the solution: `src/Vectora.Api/Vectora.sln`.

Frontend (from `src/Vectora.Client`):
- `npm install`
- `npm run dev` — Vite dev server on port 5173. **Note:** `vite.config.ts` proxies `/api` to `http://localhost:5000`, but the backend's default dev port is `5244`. When running the two separately, either start the backend on 5000 (`ASPNETCORE_URLS=http://localhost:5000 dotnet run`) or copy `.env.example` to `.env.local` and set `VITE_API_URL=http://localhost:5244/api`.
- `npm run build` — type-checks (`tsc -b`) then builds to `dist/`. The Dockerfile copies this output into `wwwroot`.

Docker:
- `docker compose up -d --build` — builds and runs the combined image on `http://localhost:8080`. Data volume is `vectora-data` mounted at `/data` (SQLite lives there).

There is no test project in this repo.

## Architecture

### Request pipeline (`Program.cs`)

Middleware order is significant and explicitly commented in `Program.cs`:

1. `ExceptionHandlingMiddleware` — translates exceptions to JSON error responses. Suppresses stack traces in non-Development environments; maps `ServiceBusException.MessagingEntityNotFound` → 404, other `ServiceBusException` → 502, `OperationCanceledException` (client disconnect) → 499.
2. `SecurityHeadersMiddleware`
3. `LoginRateLimitingMiddleware` — only acts on `/api/auth/login`; 5 attempts / 5 min window / 15 min lockout per client IP (`X-Forwarded-For` aware). Tunable via `RateLimit:*` config keys.
4. Static files + `UseDefaultFiles` — serves the built SPA from `wwwroot`.
5. `AuthMiddleware` — see below.
6. Endpoint mapping (minimal APIs grouped by feature in `Endpoints/*.cs`).
7. `MapFallbackToFile("index.html")` — SPA routing fallback.

Kestrel max request body is set to 10 MB.

### Authentication

Auth is **optional and password-only**, gated by the `VECTORA_PASSWORD` environment variable.

- If `VECTORA_PASSWORD` is unset, all requests are allowed; the frontend stores the sentinel token `"no-auth-required"` and skips the login screen.
- If set, `/api/auth/login` accepts the password (timing-safe SHA256 compare) and returns a JWT signed with `SHA256(password + "vectora-jwt-secret")`. Tokens live 24h, issuer/audience both `"Vectora"`.
- `AuthMiddleware` allow-lists `/api/auth/login|validate|status` and any non-`/api` path (static files); everything else requires a valid `Authorization: Bearer <jwt>`. Failed logins set `context.Items["LoginFailed"]` which the rate limiter reads after the pipeline unwinds.
- Frontend stores the JWT in `localStorage` under `vectora_token`; a 401 from any API call clears it and reloads the page.

Because the JWT signing key is derived from `VECTORA_PASSWORD`, **rotating the password invalidates every existing token**. If no password is set, a random key is generated per process and tokens don't survive restarts.

### Persistence

SQLite via EF Core (`VectoraDbContext`). Database file is `{DataPath}/vectora.db`, where `DataPath` defaults to `./data` locally and is set to `/data` in the container image. On startup the app:

1. Creates the data directory.
2. Applies pending migrations.
3. Enables WAL journal mode and `busy_timeout = 5000` for concurrent-write resilience.

Entities (each with a unique index on name/key):
- `ServiceBusConnection` — saved Service Bus connections; emulator mode is detected from `UseDevelopmentEmulator=true` in the connection string.
- `Setting` — key/value app settings (e.g. `BatchOperationTimeoutSeconds`, clamped 10–600).
- `MessageTemplate` — saved message bodies for resend.

### Service Bus client caching

`ServiceBusClientCache` (registered as a singleton, `Helpers/ServiceBusClientCache.cs`) holds one `ServiceBusClient` and one `ServiceBusAdministrationClient` per `connectionId` plus the connection string that was used to build them. When a connection is updated or deleted (or its connection string changes between gets), `ConnectionRepository` calls `InvalidateConnection(id)` and the cached clients are disposed in the background. Anything that talks to Service Bus must go through this cache rather than constructing clients directly.

### Emulator vs real Service Bus

**Vectora requires an emulator that serves the management API** — an Azure Service Bus Emulator build with SDK ≥ 7.20, which exposes the admin API on a separate HTTP port (5300 by default, configurable via the `EmulatorAdminPort` setting / `EMULATOR_HTTP_PORT` on the emulator). There is no degraded mode for older emulators: if the management API isn't reachable, admin calls fail and surface the error rather than serving a partial view.

`ServiceBusService.GetManagementClient` returns a `ServiceBusAdministrationClient` for every connection:

- **Real Service Bus**: built from the connection string as-is.
- **Emulator**: built from a connection string whose `Endpoint` is rewritten to the admin port (`EmulatorAdmin.BuildAdminConnectionString`). The data-plane `ServiceBusClient` keeps the original string, and messaging operations (send/peek/receive/DLQ) always go through it.

Entity enumeration, CRUD, properties, and subscription rules therefore take one code path for both. **Message counts are the single exception:** the emulator's management API does not track them — its `QueueDescription`/`SubscriptionDescription` omit `CountDetails` entirely and hardcode `MessageCount` to 0, so `Get*RuntimePropertiesAsync` always reports zero even when the entity holds messages. Counts have to be derived by browsing (peek, never consume) instead.

**Browsing never happens on a request thread.** The emulator intermittently stalls for ~12s on a single `PeekMessagesAsync` call (a fixed timeout, hitting an arbitrary page — apparently in its backing store), so counting inline made entity refreshes and entity clicks take 10-20s. `EmulatorCountRefresher` (singleton, `Services/EmulatorCountRefresher.cs`) owns all emulator peek-counting:

- `GetEntitiesAsync` enumerates via admin, carries over previously known counts by name, writes the entity cache, then calls `Trigger(connection)` and returns. The sweep mutates the **cached DTOs in place**, so a later cached read serves fresh numbers for free — don't make `IServiceBusEntityCache.TryGet` clone, or counts silently stop updating.
- A newer `Trigger` supersedes the sweep in flight (its DTOs are stale by then). Sweeps must only touch singletons and the detached connection object — never a scoped dependency, whose `DbContext` is gone once the request ends.
- Per-entity `/runtime` and the properties methods (which back MCP `describe_entity`) serve last-known counts and **start no scan of their own**. Counting an entity competes with reads of that same entity, so an earlier version that refreshed the clicked entity's count made the user's message load wait ~12s on the stall. Only an explicit entity refresh starts a sweep.
- A sweep browses just one page per entity — `EmulatorCountRefresher.PeekCap` (100) messages, `Concurrency` (8) entities at a time. The cost of counting is the number of peek calls, not messages, because of the stall.
- **Counts are floors, not totals.** Every count carries an exactness flag (`ActiveCountExact`/`DeadLetterCountExact`, default `true` so admin-reported counts are unaffected); `false` renders as `N+`. Do not infer this by comparing to the cap — the client can report totals far above it.
- The client sharpens counts as the user reads: loading N messages proves there are at least N, and reaching the end of the entity proves there are exactly N. `MessagePanel` reports `(loaded, reachedEnd)` per sub-queue, `MainLayout` merges it with the server's number via `mergeMessageCount` (a loaded total wins outright; otherwise the larger floor wins, so the counter only ever gets sharper), and the overrides are dropped on an explicit refresh. This covers scroll paging and the search drain, which scans the whole entity. When the first page comes back full, the client asks `/runtime?recount=true` — fired after the messages are on screen, never awaited before render.
- The entities response carries `countsPending` (`IsPending`, always false for real Service Bus). `MainLayout` polls the **unrefreshed** entities endpoint every 2s until it clears — polling with `refreshCache=true` would restart the sweep and never settle.

The real-Service-Bus path keeps using the admin runtime properties, which are exact and need no browsing.

Because management is now unconditional, there is no `SupportsManagement`/`canManage` flag — entity create/edit/delete UI is always available. Route any new entity-management feature through `GetManagementClient`.

### Endpoint layout

Minimal APIs grouped in `Endpoints/`:
- `AuthEndpoints` — `/api/auth/{status,login,validate}`
- `ConnectionEndpoints` — `/api/connections`
- `ServiceBusEndpoints` — `/api/connections/{connectionId:int}/servicebus/...` for entity (queue/topic/subscription) management
- `ServiceBusMessageEndpoints` — same prefix, for peek/receive/send and DLQ return/consume (both single and batch by sequence number)
- `MessageTemplateEndpoints` — `/api/message-templates`
- `SettingsEndpoints` — `/api/settings`

DTOs live in `Models/Dtos/`. `ValidationHelper` enforces entity-name and message-body/`maxMessages` rules at the endpoint boundary.

### MCP server

Vectora hosts a built-in MCP server (Model Context Protocol) at `/mcp` so AI agents can browse and test Service Bus. It uses the official `ModelContextProtocol.AspNetCore` SDK over Streamable HTTP, registered in `Program.cs` (`AddMcpServer().WithHttpTransport().WithToolsFromAssembly()` + `app.MapMcp("/mcp")`). Tools are defined in `Mcp/ServiceBusTools.cs` (`[McpServerToolType]` / `[McpServerTool]`) and delegate to the existing `IServiceBusService` and `IConnectionRepository` — no duplicated Service Bus logic.

Tools: `list_connections`, `list_entities`, `describe_entity` (full read-only config + runtime metrics of one queue/topic/subscription), `get_subscription_rules` (subscription filters/actions), `list_sessions` (peek-based, lock-free session listing), `peek_messages`, `peek_dead_letter_messages`, `send_message`. `describe_entity`/`get_subscription_rules` go through the existing `IServiceBusService` property/rule methods.

**Safety model (important):**
- **Reads are peek-only.** The read tools call `PeekMessagesAsync` exclusively, never receive/consume — browsing never locks or removes messages, consistent with the "production reads must be lock-free" rule.
- **Per-connection exposure.** A connection is invisible and unreadable to MCP unless its `ServiceBusConnection.McpExposed` flag is set; `send_message` additionally requires `McpAllowSend`. Both default `false`, so new/production connections are dark until explicitly opted in (added by the `AddMcpConnectionFlags` migration). Flags are set via `PUT /api/connections/{id}/mcp` and the MCP section of the Settings dialog.
- Read tools clamp results to ≤1000 (default 50) and return a `nextSequenceNumber` cursor for paging.

**Gating & auth.** `McpAuthMiddleware` (runs after `AuthMiddleware`, acts only on `/mcp`) reads two DB-backed settings each request: `McpEnabled` (off → 404, so toggling takes effect with no restart) and `McpApiKey` (when set, requires `Authorization: Bearer <key>`, timing-safe compared; empty → open). This is fully independent of `VECTORA_PASSWORD` — `/mcp` is not under `/api`, so the SPA's JWT layer lets it through. `/api/settings` returns the raw `mcpApiKey` so the Settings dialog can display and edit it (empty string means no key); on `PUT`, a null `mcpApiKey` leaves it unchanged and an empty string clears it.

### Frontend structure

Single-page app under `src/Vectora.Client/src/`:
- `api/client.ts` — every API call goes through one `fetchApi` helper that attaches the bearer token and reloads the page on 401. Base URL is `import.meta.env.VITE_API_URL || '/api'`.
- `App.tsx` — boots auth state, mounts `LoginPage` or `MainLayout`.
- `components/MainLayout.tsx` — top-level shell; persists the last selected connection in `localStorage` under `vectora_last_connection`.
- `components/EntityBrowser.tsx`, `MessagePanel.tsx`, `MessageViewer.tsx`, `SendMessageDialog.tsx`, `ConnectionManager.tsx`, `EditEntityDialog.tsx`, `SettingsDialog.tsx` — feature panels.
- `types/index.ts` — shared TS types mirroring the API DTOs (camelCase).

Tailwind is configured via `tailwind.config.js` + `postcss.config.js`; Monaco is loaded via `@monaco-editor/react`.

### Configuration & environment

| Variable | Used for |
|---|---|
| `VECTORA_PASSWORD` | Optional login password; also seeds the JWT signing key |
| `DataPath` | Directory for `vectora.db` (default `./data`, `/data` in container) |
| `EmulatorAdminPort` | Port the Service Bus emulator serves the management API on (default `5300`). Used to build the emulator admin connection string |
| `ASPNETCORE_URLS` | Standard ASP.NET hosting binding |
| `VITE_API_URL` | Frontend base URL for API calls (set in `.env.local` for split dev) |

CI (`.github/workflows/docker-publish.yml`) builds multi-arch images on every push/PR to `main` and pushes to Docker Hub (`jugand/vectora`) on GitHub Releases only.
