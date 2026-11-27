# Front-door authentication: one way in for every client

Status: **Proposed design; Phase 0 approved and in progress (see §9a). Three-host topology (`auth.` / `api.` / `factory.<domain>`) approved 27 Nov 2026 (see §9b).** Owner: Dale Sackrider. Requested 22 Nov 2026, 8:12 AM Phoenix time.
Builds on: [plans/factory-auth.md](../../plans/factory-auth.md) (the "Factory Auth Design": R1–R18, D1–D33) and the MCP OAuth work (TSK-339, `packages/control-plane/src/mcp-oauth.ts`).

> **Dale's requirement (verbatim):** "I do not want any endpoint to have a different authentication method than the
> 'front door' which is our login page (unauthorized traffic allowed - but should be protected against DDOS with
> Cloudflare maybe). Once authenticated - I assume the authenticated session carries a short lived token with all role
> based information to allow for usage of MCPs APIs from any interface - so a new URL like mygarrison.dalesackrider.com
> or thisismadeup.ai could host a factory console or UI because when they connect to the MCP or API - they are required
> to authenticate via a standard 'front door'."

## 1. Summary

The factory already has most of the pieces of a real front door: its own login page with configured IdPs (S12), an
OAuth 2.1 authorization server for MCP with discovery, dynamic client registration, PKCE, consent, refresh-token
rotation and revocation (TSK-339), and a grant store that decides every privilege (D1, D4). What it does **not** have is
*one* front door. Today a caller can get in six different ways, two of which (Cloudflare Access on the other hosts and
long-lived `fk_` keys) never touch the login page, and the tokens the front door does issue are bound to `/mcp` only, so
a console on another domain cannot call the API with them.

This design makes the factory's OAuth 2.1 / OIDC authorization server **the only issuer of credentials**:

1. Every human signs in at the factory login page (`/login` → configured IdP → factory session). Nothing else signs
   people in. Cloudflare Access stops being an authentication layer.
2. Every client — the factory console, a console on `mygarrison.dalesackrider.com` or `thisismadeup.ai`, Claude/Cursor
   MCP connectors, the CLI, Higgins (Tesla), Rosie (Reachy), automations — gets a **short-lived access token** from that
   one authorization server through a standard OAuth flow, and presents it as `Authorization: Bearer` to `/api/v1/*`
   and `/mcp` alike.
3. Access tokens are signed JWTs (≈10 minutes) carrying subject, audience, client, scopes and a role/grant snapshot so
   any UI can render without extra calls; the factory still re-checks live grants on every request, so a revoked grant or
   token is honoured within one request, not one token lifetime.
4. Machines that cannot open a browser use the **device authorization flow** (RFC 8628) once, approved by a signed-in
   human at the same login page, then hold only a rotating refresh token. No new long-lived `fk_` keys.
5. Cloudflare's job becomes **traffic protection only** (DDoS, WAF managed rules, rate limits on `/login`, `/authorize`,
   `/token`, `/register`, Turnstile on the login page). Browser Integrity Check exceptions and Access bypass apps go away
   because there is nothing left for them to special-case.

## 2. Current state: endpoint authentication inventory

Sources: `packages/control-plane/src/route-registry.ts` (292 routes: 220 declare a Bouncer privilege, 72 are named in
`ROUTE_EXCEPTIONS`), `app.ts` (`verifyApiKeyBeforeRouting()`, `identify()`, `requirePrivilege()`), `login.ts`,
`mcp-oauth.ts`, `keys-routes.ts`, `grants-routes.ts` (whoami), `speak-as-converse.ts`, `packages/auth/src/index.ts`
(`authFromEnv`, `RunTokens`), `packages/auth/src/access.ts`, `packages/console/server.ts`, `packages/cli/src/credentials.ts`,
`packages/gatekeeper/src/ingress/server.ts`. Live checks were read-only `curl` probes and a read-only Cloudflare API read
on 22 Nov 2026.

### 2.1 How `identify()` decides who is calling today (`app.ts` ~L1653)

In order, first match wins:

| # | Credential | Where verified | Issued by the front door? |
|---|---|---|---|
| 1 | `fk_…` key in `Authorization: Bearer` (person device keys, `service:<name>` keys, break-glass, MCP OAuth access tokens `fk_at_…`) | `verifyApiKeyBeforeRouting()` before routing on `/api/v1/*`, `/mcp`, `/healthz`, `/`, `/metrics`; hashed lookup in KeyStore; owner's live grants ∩ key scopes | **Partly.** `fk_at_` (1 h) comes from `/token`; `cli` keys come from the login loopback; person device keys (e.g. Stephanie's `tesla` key) and `service:*` keys are minted by `POST /api/v1/keys` and may be **non-expiring** (R6, D3). |
| 2 | Any other `Authorization` value | `state.auth.verify()` = `authFromEnv()`: static `FACTORY_TOKEN` admin bearer and/or external OIDC JWT (`FACTORY_OIDC_ISSUER/AUDIENCE`) | **No.** A static admin bearer and a second IdP path that bypass the login page. |
| 3 | `factory_session` HttpOnly cookie (12 h, in-memory, SameSite=Lax, same-origin check on writes) | `verifySession()` in `login.ts` | **Yes** — this *is* the front door. |
| 4 | `Cf-Access-Jwt-Assertion` header / `CF_Authorization` cookie | `state.access.verify()` (`access.ts`) | **No.** Cloudflare Access login page, not the factory's. |
| 5 | Run token (HS256 `factory-run+jwt`, 6 h) on `skills.register` and the 22 `run-token` routes | `RunTokens.verify()` + run must still be live | No (machine-internal; see §5.6). |

### 2.2 Route groups

| Route group | Today's protection | Deviates from front door? |
|---|---|---|
| `/login`, `/`, `/api/v1/auth/:idp/start`, `/api/v1/auth/:idp/callback`, `/api/v1/auth/logout` | Public (`login-page`, `oauth-state-pkce`); IdPs = Google, Meta, Cloudflare, generic OIDC (`idp-config.ts`) | No — this is the front door. |
| `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/mcp]`, `/register`, `/api/v1/auth/register`, `/authorize`, `/token`, `/revoke` (+ `/api/v1/auth/oauth/*` aliases) | Public OAuth endpoints; DCR rate-limited per IP in-process; `/authorize` requires a factory session + consent | No — but tokens it mints are `/mcp`-only (audience check in `verifyApiKeyBeforeRouting`: *"Token audience does not permit direct API access"*), and only `authorization_code` + `refresh_token` grants exist (no device flow). |
| `/ui` | Session (else 302 `/login`) | No. |
| 220 privileged `/api/v1/*` routes | Any of credentials 1–4 then Bouncer | **Yes** — accept static `FACTORY_TOKEN`, external OIDC bearer, Cloudflare Access JWT, and long-lived `fk_` keys alongside the session. |
| `/mcp` | `fk_` / `fk_at_` bearer, or session/Access via `identify()`; 401 carries `WWW-Authenticate: Bearer resource_metadata=…` | **Partly** — MCP OAuth is front-door, but static `fk_` device keys (Higgins, Rosie) also work. |
| `/api/v1/keys` (list/create/rotate/revoke) | Handler checks; **API keys and tokens refused** ("API keys cannot manage API keys; sign in") | Session-only by design; becomes a scope (`keys:manage`) under the new model. |
| `/api/v1/grants`, `/api/v1/oauth/consents`, transfers | `transitional` (handler-side authz, retiring in S4) | Same credentials as row "privileged". |
| `/api/v1/whoami`, `/authz/check`, `/setup/status`, `/openapi.json`, `/mcp/schema.json` | `identity-probe` (any verified principal) | Same as above. **Bug:** whoami's `signedInWith` is inferred from headers (`grants-routes.ts` L1329: `authorization ? 'api-key' : sessionIdp ?? 'cloudflare-access'`). MCP tool calls are dispatched in-process with no `authorization` header (`mcp.ts` `createInProcessRequest`), so a Higgins `fk_` call reports `cloudflare-access`. |
| `/healthz`, `/api/v1/health` | Registry says verified principal only (R17), **but the console server answers both without credentials** (`console/server.ts` L80; live: 200 `factory-console 0.2.0`) | **Yes** (low risk: no data, but contradicts R17). |
| `/api/v1/runs/:id/*`, `/mcp/run`, `/api/v1/keymaster/checkout`, `/api/v1/fleet/state/ops`, `PUT /agents/:id/holds/:key` (22 routes) | Run token minted at container start | Machine-internal; kept, but re-homed under the same issuer (§5.6). |
| `/hooks/:id`, `/hooks/github`, `/webhooks/github` (+ `/api/v1/` aliases) | HMAC signature, fail-closed (R16) | Not a human front door; stays HMAC (§5.7). |
| `/api/v1/connections/:provider/callback`, `/api/v1/keymaster/github-app/callback` | Signed one-time state + PKCE | No (third-party OAuth callbacks). |
| `POST /api/v1/converse` speak-as (Higgins/Rosie) | Client authenticates with its `fk_` key; **speaker** comes from body/`x-factory-speaker` headers with an `assurance` label, resolved against the client's speak-as grant | Client auth deviates (static key). Speaker remains an *asserted* identity (§5.5). |
| gatekeeper ingress → control plane | `Authorization: Bearer $FACTORY_TOKEN` if set (`gatekeeper/src/ingress/server.ts`) | **Yes** — static shared admin secret. |
| CLI | Login loopback → `cli` `fk_` key (S13); legacy path still documents `cloudflared access login` Access token (`cli/src/credentials.ts`) | **Partly.** |

### 2.3 Hosts and Cloudflare (read-only, 22 Nov 2026)

| Host | Cloudflare Access | Effective front door |
|---|---|---|
| `factory-dashboard.dalesackrider.com` (console + proxied API/MCP/OAuth; OAuth issuer) | Access app "Agent Factory Console (bypass; factory login enforces auth)" — bypass everything | Factory login (correct). `/` and `/ui` → 302 `/login`. |
| `agent-factory.beercanlabs.com` (control plane direct) | Access app "Agent Factory Control Plane" protects everything; separate bypass app for `/login`, `/api/v1/auth/*`, OAuth endpoints, `/mcp`, `/mcp/*` | **Cloudflare Access login** for `/api/v1/*` and `/ui` (live: 302 to `beercanlabs.cloudflareaccess.com`). |
| `garrison.dalesackrider.com` | Same "Control Plane" Access app, **no** bypass | **Cloudflare Access login** for everything, including `/login` and `/mcp`. |
| — | Access SaaS app "Agent Factory Sign-in (OIDC)" | Cloudflare used as an IdP behind the factory login (fine; it is one of the configured IdPs). |

Zone `dalesackrider.com` (`0d9db5ba518fec4df7780d4368d34dd6`): Browser Integrity Check **on** zone-wide, security level
medium, WAF setting off, one `http_config_settings` rule (ruleset `807657c1feab4895af0c0be16ea36cd0`) turning BIC off
for `factory-dashboard…/mcp` only. Effect: non-browser clients with default user agents (e.g. `Python-urllib`) get
Cloudflare **1010/403** on `/api/v1/*` but not on `/mcp`. No rate-limiting rules and no Turnstile on `/login` today.

### 2.4 Deviations, ranked

1. **Cloudflare Access is a second login page** on `agent-factory.beercanlabs.com` and `garrison.dalesackrider.com`.
2. **Long-lived bearer secrets that never meet the login page:** non-expiring person device keys and `service:*` keys
   (`POST /api/v1/keys`), the static `FACTORY_TOKEN` admin bearer (`authFromEnv`, gatekeeper ingress), break-glass.
3. **External OIDC bearer path** (`FACTORY_OIDC_ISSUER`) that skips the factory login and maps roles from claims.
4. **Front-door tokens can't reach the API:** `fk_at_` tokens are audience-bound to `/mcp`, so a third-party-hosted
   console cannot work; there is no CORS support at all, and the session cookie is (correctly) same-origin only.
5. **Cloudflare BIC treats `/mcp` and `/api/v1/*` differently** — an edge-level authentication-ish distinction.
6. **Health endpoints open** on the console host (contradicts R17).
7. **whoami mislabels** the sign-in method (`cloudflare-access` for `fk_` calls through MCP).
8. **Key management is session-only** — correct intent, but expressed as "API keys can't manage keys" rather than as a
   scope a front-door token can carry.
9. **Sessions are in-memory** (restart signs everyone out; won't survive more than one control-plane task).

## 3. Goals and non-goals

**Goals**
- G1. Exactly one place where a human authenticates: the factory login page. Exactly one issuer of credentials: the
  factory authorization server (AS).
- G2. Every protected endpoint (`/api/v1/*`, `/mcp`, and first-party `/ui` on `factory.<domain>`) accepts exactly one
  credential type from outside the cluster: a factory-issued access token. The first-party web shell on
  `factory.<domain>` authenticates at `auth.<domain>` and talks only to `api.<domain>` with Bearer tokens (a BFF on
  the factory origin may hold the refresh token). The session cookie stays on the issuer origin only and is never an
  API credential. No endpoint authenticates differently.
- G3. Any origin may host a factory UI or MCP client; it gets in through the same front door (OAuth 2.1 + PKCE).
- G4. Short-lived access tokens carrying identity, audience, client, scopes and role information; refresh tokens to
  avoid repeated logins; immediate revocation.
- G5. Devices (Higgins, Rosie, CLI, automations) authenticate through the same AS; no new long-lived static keys.
- G6. Speak-as keeps a *verified client* plus an *asserted, graded speaker*, never the reverse.
- G7. Cloudflare protects availability (DDoS, WAF, rate limits, Turnstile) and makes no authentication decision.
- G8. Zero-outage migration for Higgins, Rosie, CLI and existing MCP connectors.

**Non-goals**
- Replacing the grant store or Bouncer (D1/D4 stand: the IdP says who, the factory says what).
- Becoming an IdP for passwords. People still prove identity with Google/Meta/Cloudflare/OIDC; the factory federates.
- Multi-tenant (multi-org) isolation — tracked separately by the adoption-guides work.
- Webhook senders (GitHub etc.) signing in; they keep HMAC (§5.7).

## 4. Target architecture

```
           ┌────────────────────────── Cloudflare (traffic only) ──────────────────────────┐
           │ DDoS · WAF managed rules · rate limits (/login /authorize /token /register    │
           │ /device) · Turnstile on /login · no Access apps · no BIC exceptions           │
           └───────────────────────────────────────────────────────────────────────────────┘
                                             │
   factory.<domain> web shell ────┐          ▼
    (Console, Garrison (3D), 2D   ├─▶ https://auth.<domain>   Front door / Authorization Server
     game, Web Chat, Connect)     │     /login  /authorize  /token  /device  /register  /revoke  /jwks
   Third-party console (any origin)┤    IdPs: Google · Meta · Cloudflare · OIDC  (identity only, D1)
   Claude / Cursor MCP client ────┤              │ access token (JWT, ~10 min)
   CLI (loopback + PKCE) ─────────┤              ▼
   Higgins / Rosie (device flow) ─┤     https://api.<domain>   Headless neck (one verifier)
   Automations (device / client) ─┘       /api/v1/*  /mcp  /mcp/agents/:id
                                          /api/v1/agents/:id/conversation  webhooks
                                          verify JWT → sub, aud, scope, client, act, sid → live grants
                                          → Bouncer authorize() → ledger
```

### 4.0 Host topology (D-1, D-7)

The product is generic: every deployment exposes three public hostnames. `dalesackrider.com` is the concrete running
example, not part of the product name.

| Host (generic) | Concrete example | Role |
|---|---|---|
| `auth.<domain>` | `auth.dalesackrider.com` | Single authentication / OIDC+OAuth issuer — the one front door. Hosts `/login`, `/authorize`, `/token`, `/device`, `/register`, `/revoke`, `/.well-known/*` and `/jwks`. Session cookies live only on this origin. |
| `api.<domain>` | `api.dalesackrider.com` | The headless neck. Hosts `/api/v1/*`, `/mcp`, `/mcp/agents/:id`, `/api/v1/agents/:id/conversation`, and webhooks. Every head — browser, CLI, MCP client, device — talks to this neck with a factory-issued Bearer token. |
| `factory.<domain>` | `factory.dalesackrider.com` | First-party browser shell for all web-enabled heads, under one top nav switcher (name not yet vetted; "head switcher" is a placeholder). Authenticates against `auth.<domain>` and talks only to `api.<domain>`. |

The first-party heads on `factory.<domain>` (tracked in [#559](https://github.com/BeerCanLabs/agent-factory/issues/559)):

1. **Web Console** — operations/admin UI.
2. **Garrison (3D)** — the existing 3D gaming interface (moves here from a separate `garrison.<domain>` public host). Garrison stays the 3D interface; it is not replaced by the 2D game.
3. **2D game interface (Zelda-style)** — a planned additional game head, separate from Garrison, under the same top nav switcher. Name and layout still to be designed (loop in UX Design).
4. **Web Chat** — chat with any factory agent in the browser via the neck's `/api/v1/agents/:id/conversation`, so agents are not Discord-only.
5. **Connect / non-web heads page** — instructions for connecting AI apps (Grok Bot, Claude, Cursor, and similar) via MCP at `https://api.<domain>/mcp`, and for downloading, installing, and authenticating the Factory CLI.

`factory-dashboard.<domain>` remains an issuer/resource alias until phase 3 (D-1) so existing MCP connectors keep working, then redirects to the new hosts. `agent-factory.beercanlabs.com` is retired as a public advertised host. This topology is design authority only: it does not itself change live DNS, Cloudflare, AWS, or production UI.

Third-party or additional consoles may still be hosted on any origin (`mygarrison.dalesackrider.com`, `thisismadeup.ai`, …) and reach the same neck through the same front door (§4.3).

### 4.1 One authorization server

- **Issuer**: `https://auth.<domain>` (D-1; concrete example `https://auth.dalesackrider.com`). Path-based issuers
  such as `https://<domain>/auth` are not used — OAuth/OIDC discovery and cookie isolation expect the issuer at the
  root of its own hostname. `https://factory-dashboard.dalesackrider.com` stays an alias issuer until phase 3 so
  existing MCP connectors keep working. Everything is advertised by `/.well-known/oauth-authorization-server` and
  `/.well-known/openid-configuration` (RFC 8414, OIDC Discovery), plus `jwks_uri`.
- **Login page** is the only interactive authentication UI. `/authorize` without a factory session redirects to
  `/login?return=…`; after the IdP callback the AS sets its own session cookie **on the issuer origin only** and resumes
  the authorization request.
- **Grant types**: `authorization_code` + PKCE S256 (all browser apps, MCP clients, CLI), `refresh_token` (rotating,
  family-revocation on reuse — already built in `mcp-oauth.ts`), `urn:ietf:params:oauth:grant-type:device_code`
  (RFC 8628; Higgins, Rosie, headless automations), `urn:ietf:params:oauth:grant-type:token-exchange` (RFC 8693; only for
  the factory's own internal services and speak-as, §5.5–5.6). No implicit, no password grant, no client-credentials for
  people.
- **Client registry**: public clients only for anything outside the cluster (`token_endpoint_auth_method: none`).
  Registration by (a) Client ID Metadata Documents (already supported, `client_id_metadata_document_supported: true`),
  (b) Dynamic Client Registration (RFC 7591, kept for MCP spec compatibility), (c) admin pre-registration for
  first-party clients (console, CLI, Higgins, Rosie) with a "first-party" flag that skips the consent screen.
- **Consent**: per (principal, client, scope set); listed and revocable in the console (already: `/api/v1/oauth/consents`).

### 4.2 Tokens

| Token | Form | Lifetime | Holder | Notes |
|---|---|---|---|---|
| Factory session | Random id in HttpOnly cookie on the **issuer origin only**; server-side record (hash) | 12 h idle / 7 d absolute (D-4) | Browser | Only the AS reads it. Moves from in-memory to the durable store. |
| Access token | JWT, `typ: at+jwt` (RFC 9068), ES256/EdDSA, `kid` in JWKS | **10 min** (D-3) | Client | Sent as `Authorization: Bearer` to `/api/v1/*` and `/mcp`. |
| Refresh token | Opaque, hashed at rest, rotating, family id | 30 d sliding for people; 90 d sliding for approved devices (D-4) | Client (browser apps: in memory or via BFF; devices: secure storage) | Reuse of an old generation revokes the whole family (built). |
| Device code / user code | Opaque | 10 min | Device / human | RFC 8628. |
| Run token | JWT signed by the same AS key set, `aud: agent-factory:run` | life of run, ≤ 6 h | Agent container | Replaces the separate HS256 secret (§5.6). |

**Access-token claims** (answering "carries all role-based information"):

```json
{
  "iss": "https://auth.dalesackrider.com",
  "sub": "user:stephanie",                 // canonical principal (D2)
  "aud": ["https://api.dalesackrider.com/api", "https://api.dalesackrider.com/mcp"],  // generic: https://api.<domain>/api and /mcp
  "client_id": "higgins-tesla",            // which app / device
  "scope": "mcp agents:converse agents:read",
  "roles": ["operator"],                   // fleet roles at issue time (display/UX hint)
  "grants_v": 4182,                        // grant-store version at issue time
  "agents": {"higgins": ["member"]},       // scoped grants, truncated if large (see below)
  "sid": "sess_…",                         // session / device-grant id for revocation
  "act": {"sub": "client:higgins-tesla"},  // RFC 8693 actor when a device/agent acts for the person
  "amr": ["google"],                       // how the human proved identity (fixes the signedInWith bug)
  "iat": 1732288320, "exp": 1732288920, "jti": "…"
}
```

**Authorization stays live (important).** D3 requires a key's owner's *current* grants to decide every request. The
resource server therefore treats `roles`/`agents` as a **hint for UIs**, and on every request (a) verifies signature,
`iss`, `aud`, `exp`; (b) checks `sid`/`jti` against an in-memory revocation set fed from the durable store; (c) loads
the principal's live grants (already in memory) and intersects with token `scope`; (d) calls Bouncer. Cost: one map
lookup — no network call. Effect: revoking a grant, a consent, a device or a session takes effect on the next request,
while a third-party console can still render menus from the token alone. If `grants_v` in the token is older than the
store, the response carries `X-Factory-Grants-Stale: 1` so UIs refetch `whoami`.

**Scopes** (coarse, consented; privileges stay fine-grained in Bouncer): `openid profile email`, `mcp`, `api`,
`agents:read`, `agents:converse`, `agents:manage`, `skills:manage`, `grants:manage`, `keys:manage`, `admin`, `offline_access`.
A token can never exceed the principal's live grants; scopes only narrow (same rule as `fk_` key scopes today).

**Audiences**: one audience per resource on the neck host (`https://api.<domain>/api`, `https://api.<domain>/mcp`),
requested with RFC 8707 `resource`. A console or the first-party web shell asks for both; an MCP connector asks only
for `/mcp` (current behaviour kept).

### 4.3 Consoles on any origin (`mygarrison.dalesackrider.com`, `thisismadeup.ai`)

1. The console is a **public OAuth client** registered by a Client ID Metadata Document at
   `https://thisismadeup.ai/oauth/client.json` (or by an admin). Its `redirect_uris` must be on its own origin.
2. User clicks "Sign in" → browser goes to the factory `/authorize` (PKCE S256, `resource=…/api`, `resource=…/mcp`) →
   factory `/login` → IdP → back to the factory → consent screen naming the console's origin → redirect with code.
3. Console exchanges the code at `/token` (CORS-enabled for registered origins) and calls `/api/v1/*` and `/mcp` with
   `Authorization: Bearer`. No cookies cross origins; CSRF is moot because the bearer is not ambient.
4. **CORS**: the API, MCP, `/token` and `/revoke` answer preflights only for origins derived from registered clients'
   redirect URIs (exact origin match, no wildcards, `Access-Control-Allow-Credentials: false`). The CORS allow-list *is*
   the client registry, so adding a console is one registration, not a config change.
5. **Token handling in the browser**: access token in memory; refresh token either in memory (re-login per tab after
   30 min idle) or behind a tiny backend-for-frontend on the console's origin (recommended for production consoles,
   per the IETF "OAuth 2.0 for Browser-Based Apps" BCP). DPoP (RFC 9449) is a phase-4 hardening option.
6. **Who may register a console**: decision D-2. Recommended: anyone may register (MCP spec expects this), but
   unverified/third-party clients get a prominent consent screen ("thisismadeup.ai wants to act as you: read agents,
   converse…"), are capped to non-admin scopes, and an admin can promote a client to "trusted" (allows `admin`/`grants:manage`
   scopes) or block it.

### 4.4 MCP authorization (per the MCP 2025-06-18 authorization spec)

Already largely conformant; the changes are:
- `/mcp` keeps answering 401 with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
- Protected-resource metadata lists `authorization_servers: [issuer]` and real `scopes_supported` (not just `mcp:full`).
- Access tokens become JWTs (§4.2); `aud` must include the MCP resource (RFC 8707) — already enforced.
- Tokens are never passed through to downstream services (spec "token passthrough" ban); the factory uses its own
  ConnectionKeymaster credentials downstream.
- Static `fk_` keys stop being accepted on `/mcp` at the end of phase 3.
- Fix: MCP in-process dispatch carries the verified credential context, so whoami reports `amr`/`client_id` correctly.

### 4.5 Devices and automations

| Client | Today | Target flow |
|---|---|---|
| CLI (`factory login --url`) | Loopback + PKCE → long-lived `cli` `fk_` key | Same loopback + PKCE, but the result is an access + refresh token pair (first-party client `factory-cli`). `factory login --device` for SSH/headless. |
| Higgins (Tesla) as Stephanie | Stephanie's non-expiring `tesla` `fk_` key, scoped to `higgins`, in Higgins's hosted connector | Higgins's connector is a registered client (`higgins-tesla`). One-time **device flow**: Higgins shows a code; Stephanie (or an admin acting-as, ledgered) approves at `/device` after signing in. Higgins stores only the refresh token (90 d sliding) and gets 10-min access tokens with `act: client:higgins-tesla`, `scope: mcp agents:converse`, `resource: …/mcp`. If Higgins's platform only supports MCP OAuth (authorization-code), it uses that instead — same front door. |
| Rosie (Reachy) | `fk_` key + speak-as grant | Same as Higgins (device flow, client `rosie-reachy`). |
| Claude / Cursor / other MCP hosts | MCP OAuth (already front door) | Unchanged apart from JWT tokens. |
| Scheduled automations owned by a person | `fk_` key, family `automation` | Device flow once → refresh token in the automation's secret store. |
| Factory-internal services (gatekeeper ingress/egress, ingest, health probe) | `service:*` `fk_` keys; static `FACTORY_TOKEN` | Workload identity: the service proves itself with its cloud identity (AWS IAM role / ECS task role, signed STS `GetCallerIdentity` or an IAM-signed JWT) at `/token` via token exchange and receives a 10-min `service:<name>` token. No static secret in env. Inside the private network only; never exposed through Cloudflare. |
| Break-glass | Non-expiring `service:break-glass` key in Secrets Manager | Kept as the *one* documented exception (R9: must work when the login page/IdPs are down), reachable only from the private network via `bcl-aws`, every use ledgered + bannered (already). Decision D-6. |

### 4.6 Speak-as with verified identity preserved

- The **client** (Higgins/Rosie) is always verified: its access token's `client_id`, `act`, and `sub` (the person who
  approved the device, e.g. Stephanie) come from the front door.
- The **speaker** (who is talking to the car/robot right now) stays an assertion graded by `assurance`
  (`voice-asserted`, `enrolled-voice`, …) and is honoured only within the client's speak-as grant
  (`speak-as-converse.ts` `applySpeakAs`). The token never claims the speaker is verified.
- Moving speaker fields from free-form headers into a signed request object (or a token-exchange step that mints a
  narrowly-scoped token `sub=user:<speaker>`, `act={client}`, `assurance=…`, 5 min) is phase 4; until then the header
  path keeps working but only for clients holding a speak-as grant (today's rule).
- Ledger entries record `client_id`, `sub`, `act`, speaker, assurance.

### 4.7 Revocation

| Action | Effect | Mechanism |
|---|---|---|
| Sign out | Session + refresh-token family for that session revoked | `sid` added to revocation set; next request 401 |
| Revoke a device / app (console "Connected apps") | All tokens for (principal, client) revoked | Consent delete → family revoke → `sid` set (extends existing `/api/v1/oauth/consents`) |
| Revoke a grant / role | Next request denied | Live grant check (tokens carry hints only) |
| Disable a person | All sessions/families revoked; principal blocked | Principal flag checked on every request |
| Key compromise of AS signing key | Rotate `kid`; old `kid` removed from JWKS | Max exposure = access-token lifetime |
| `/revoke` (RFC 7009) | Client-initiated | Already built; extend to JWT `jti` |

Revocation set is durable (S3 config store) and cached in memory; entries expire with the token they revoke.

## 5. Specific endpoints after the change

### 5.1 Public (no credential), each named in `ROUTE_EXCEPTIONS`
`/login`, `/api/v1/auth/:idp/start|callback`, `/authorize`, `/token`, `/revoke`, `/device`, `/register`,
`/.well-known/*`, `/jwks`, `/logout`. All rate-limited at Cloudflare and in-process; `/login` and `/device` carry Turnstile.

### 5.2 Bearer access token only
All 220 privileged `/api/v1/*` routes, identity probes (`whoami`, `authz/check`, `setup/status`, schemas), keys,
grants, consents, transfers, speak-as, `/mcp`, health (R17: a probe token or the private health port).

### 5.3 First-party web shell on `factory.<domain>`
The first-party shell (Console, Garrison (3D), 2D game, Web Chat, Connect) lives on `factory.<domain>`, authenticates against
`auth.<domain>`, and calls only `api.<domain>` with Bearer tokens. A tiny backend-for-frontend on the factory origin
is the recommended way to hold the refresh token (IETF "OAuth 2.0 for Browser-Based Apps" BCP). The session cookie
stays on the issuer origin (`auth.<domain>`) and is never an API credential. (Phase 2 may keep accepting the cookie on
`/api/v1/*` only while the neck still shares a host with the console during migration; once `api.` and `factory.` are
split, the cookie must not be accepted on the neck.)

### 5.4 Removed credential paths
`Cf-Access-Jwt-Assertion` (credential 4), `FACTORY_TOKEN` (credential 2a), external `FACTORY_OIDC_*` bearer
(credential 2b — re-introduced only as an *IdP behind the login page*), non-expiring person `fk_` keys.

### 5.5 Speak-as
See §4.6.

### 5.6 Run tokens
Stay as the agent container's credential (they're scoped to one live run and checked against run state), but are
signed by the AS key set and verified via JWKS — one issuer, one key rotation story. They are only reachable on the
private network (the run endpoints are not served through the public hostnames — decision D-7 confirms).

### 5.7 Webhooks
GitHub and agent webhooks keep HMAC-SHA256 (senders can't do OAuth). They are machine-to-machine signatures, not a
competing human login, and are listed in `ROUTE_EXCEPTIONS`. Cloudflare rate-limits them and can restrict
`/hooks/github` to GitHub's published IP ranges.

## 6. Cloudflare layer (traffic protection only)

| Control | Setting | Why |
|---|---|---|
| DDoS | Cloudflare HTTP DDoS managed ruleset (on by default, all plans) | Volumetric protection for the public, unauthenticated endpoints Dale allows. |
| WAF managed rules | Cloudflare Free Managed Ruleset now; Cloudflare Managed + OWASP if the zone moves to Pro (≈$20–25/mo; decision D-8) | Generic exploit filtering. |
| Rate limiting | Free plan: 1 rule. Proposed single rule: `/login`, `/authorize`, `/token`, `/register`, `/device`, `/api/v1/auth/*` → 30 req / 10 s per IP → block 10 s. Pro adds more rules (e.g. a separate `/token` rule, `/mcp` burst rule). | Credential stuffing, code-guessing, DCR spam. In-process limits stay as the second layer. |
| Turnstile | Invisible widget on `/login` and `/device`, verified server-side in the factory (Siteverify) before redirecting to the IdP | Bot sign-in attempts without hurting people. Free. |
| Bot Fight Mode | Off for API/MCP hostnames | Would block legitimate MCP/CLI/device clients. |
| Browser Integrity Check | **Off** for the factory hostnames (replace the `/mcp`-only rule `807657c1…` with a host-wide rule, then delete it) | BIC blocks non-browser clients (1010) and is the edge-level "different treatment" Dale wants gone. Rate limits + Turnstile replace it. |
| Cloudflare Access | Delete "Agent Factory Control Plane", "Console (bypass)" and "OAuth & MCP Neck (bypass)" apps once nothing depends on them. Keep "Agent Factory Sign-in (OIDC)" *only* if Cloudflare stays a configured IdP. | Access was a second front door; the factory now enforces auth itself (R14). |
| Origin lock | Origin accepts traffic only from Cloudflare (ALB security group on Cloudflare IP ranges or Cloudflare Tunnel) | Stops attackers bypassing the edge controls. |
| Custom/third-party console domains | Static UI hosting anywhere (incl. Cloudflare Pages); no Cloudflare config needed on the factory side because CORS follows the client registry | `thisismadeup.ai` needs no change to the factory zone. |

## 7. Phased rollout (no outage for Higgins, Rosie, CLI)

Every phase is additive until its last step; old credentials are removed only after the ledger shows zero use for 7
days.

**Phase 0 — Fix and observe (≈1–2 days).**
- Fix whoami `signedInWith` (carry verified credential kind through `identify()` and MCP in-process dispatch).
- Ledger every request's credential kind (`session`, `oauth-at`, `fk-device`, `fk-service`, `factory-token`,
  `access-jwt`, `oidc-bearer`, `run-token`) → a console "Who still uses old credentials" view.
- Close the console host's open `/healthz` and `/api/v1/health` (or move to the private port).
- Cloudflare: add Turnstile-free rate-limit rule on login/OAuth endpoints (Free plan's one rule). *(Needs Dale's yes;
  live config.)*

**Phase 1 — One issuer, JWT access tokens (≈1 week).**
- AS signing keys (KMS-backed or Secrets Manager, rotated), `/jwks`, OIDC discovery.
- `/token` issues JWT access tokens (10 min) for `api` and `mcp` audiences; resource verifier accepts JWT **and**
  existing `fk_at_` / `fk_` (dual-run).
- Durable sessions and revocation set.
- Scopes and consent screen by scope; first-party client flag.

**Console screens during Phase 1** (what operators should see; stale Cloudflare Access branding is removed):
- **Slice 1:** The identity chip shows the real sign-in method (`signedInWith`). Login already refuses an unverified email; `#527` closes the same hole on the OIDC bearer path. **Your API Keys** surfaces the factory issuer, OpenID configuration URL, and JWKS URL. Static `fk_` / `fk_at_` keys remain listed (dual-run starts in Slice 2).
- **Slice 2:** whoami reports a distinct method for a factory JWT vs a legacy `fk_at_` or static `fk_` key. Keys copy may note that new access tokens are 10-minute JWTs; the keys UI is not removed.
- **Slice 3:** Account / People & Access can list and revoke sessions and refresh families. Copy names the D-4 lifetimes (12 h idle / 7 d absolute; 30-day people / 90-day device refresh). Sign-out revokes that session's refresh family.
- **Slice 4:** The consent page lists requested scopes and the client's origin. Connected apps show granted scopes. First-party heads are not mistaken for third-party consoles. Third-party clients are not offered admin / grants-manage / keys-manage.
- **Slice 5:** Privileges in the sidebar keep matching *live* grants (D-5). Add the Phase 0 leftover **"Who still uses old credentials"** view (§10 item 2) so operators can see remaining `fk_`, `factory-token`, `oidc-bearer`, and `cloudflare-access` use before Phase 3.

**Phase 2 — Any-origin consoles and device flow (≈1 week).**
- CORS from client registry; `resource=…/api` audience allowed for browser clients.
- First-party console switched to Bearer tokens (BFF on its own origin).
- Device authorization endpoint + `/device` approval page (with act-as for admins, ledgered).
- CLI issues tokens (loopback + `--device`) instead of `cli` `fk_` keys.
- Proof: a demo console on `mygarrison.dalesackrider.com` signs in via the front door and lists agents.

**Phase 3 — Migrate devices and services, retire old paths (≈1–2 weeks, paced by device owners).**
- Higgins: register client, run device flow with Stephanie, switch the hosted connector to OAuth; keep the old `tesla`
  key valid until the new path has worked for 7 days; then revoke it. Same for Rosie.
- Gatekeeper ingress/egress, ingest, probes → workload-identity token exchange; remove `FACTORY_TOKEN`.
- Stop issuing non-expiring person keys; `POST /api/v1/keys` returns 410 with a pointer to device flow (admin-only
  override during the window).
- Remove `Cf-Access-Jwt-Assertion` and external OIDC bearer from `identify()`.
- Run tokens signed by the AS key set.

**Phase 4 — Edge cleanup and hardening.**
- Cloudflare: BIC off for factory hosts, delete the `/mcp` BIC rule, delete the three Access apps, origin lock,
  Turnstile on `/login` and `/device`. *(All live config; each needs Dale's yes.)*
- Optional: DPoP sender-constrained tokens, signed speak-as request objects, Pro plan WAF.
- Conformance test: every route either declares a privilege and accepts only JWT bearer (+ first-party session in
  transition) or is in `ROUTE_EXCEPTIONS` with protection in {`login-page`, `oauth-*`, `webhook-hmac`, `run-token`}.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Higgins's/Rosie's hosting platform can't do device flow or OAuth | Confirm first (phase 0). Fallback: the platform uses MCP authorization-code OAuth (it already supports hosted MCP connectors). Last resort: a short-lived (≤30 d) key minted by device approval and auto-rotated — still issued by the front door. |
| Live grant check per request removes "pure JWT" statelessness | It's an in-memory lookup already done today; no extra network. Keeps D3 promise. |
| Third-party consoles phishing users ("thisismadeup.ai" is malicious) | Consent screen shows the real origin; unverified clients capped below admin; admin can block; consent revocable; refresh tokens bound to client. |
| Locking everyone out during cutover | Additive phases; break-glass key unaffected; ledger-driven removal; feature flags per credential kind. |
| AS signing key leak | KMS-held key, short tokens, `kid` rotation runbook. |
| Removing Cloudflare Access exposes the control-plane host to the internet | The factory already enforces auth on every route (R14, conformance test); add origin lock, WAF, rate limits first. |
| BIC off increases bot noise | Rate limits + Turnstile + in-process DCR limits; can re-enable BIC on `/ui` HTML only if needed (doesn't affect API clients). |
| Free plan has only one rate-limit rule | One combined rule covers all auth endpoints; Pro (≈$20–25/mo) if more are needed — Dale decides. |
| Browser refresh-token theft (XSS on a console) | Memory-only storage or BFF; refresh rotation with reuse detection (built); short access tokens; CSP on first-party console. |
| Multiple control-plane tasks | Sessions/revocation/refresh state in the durable store (phase 1). |

## 9. Decisions Dale must make

- **D-1 Issuer URL.** Keep `https://factory-dashboard.dalesackrider.com` as the front door, or move to a dedicated
  `https://auth.dalesackrider.com` (cleaner for third-party consoles; one-time reconnect for MCP clients)?
  *Recommendation: dedicated `auth.` host, introduced in phase 1 with the old issuer kept as an alias until phase 3.*
- **D-2 Third-party consoles.** Allow any origin to register (with consent + non-admin cap), or require admin approval
  for every new console origin? *Recommendation: open registration, admin-only promotion to trusted.*
- **D-3 Access-token lifetime.** 5, 10 or 15 minutes? *Recommendation: 10.*
- **D-4 Session and refresh lifetimes.** People: 12 h idle / 7 d absolute session, 30-day sliding refresh. Devices:
  90-day sliding refresh. Acceptable?
- **D-5 Roles in the token.** Tokens carry role/grant hints for UIs but the server re-checks live grants each request
  (recommended), or trust the token's roles for its lifetime (faster, but revocation waits up to 10 min)?
- **D-6 Break-glass.** Keep the sealed non-expiring break-glass key as the single documented exception (private network
  only), or replace it with an AWS-IAM-gated token exchange?
- **D-7 Hosts.** Retire `agent-factory.beercanlabs.com` and `garrison.dalesackrider.com` as public hosts (one public
  host + one auth host), or keep them and remove their Access apps?
- **D-8 Cloudflare plan.** Stay on Free (1 rate-limit rule, free managed WAF) or move `dalesackrider.com` to Pro
  (≈$20–25/mo) for more rate-limit rules and the full managed WAF?
- **D-9 Speak-as hardening timing.** Keep header-based speaker assertion through phase 3, or require signed speaker
  assertions before Higgins/Rosie migrate?

## 9a. Decisions recorded (Dale Sackrider, 22 Nov 2026, 8:45 AM Phoenix time)

| # | Decision | Effect on this design |
|---|---|---|
| D-1 | **Login moves to `https://auth.dalesackrider.com`.** | `auth.dalesackrider.com` becomes the issuer and hosts `/login`, `/authorize`, `/token`, `/device`, `/register`, `/revoke`, `/.well-known/*` and `/jwks`. `factory-dashboard.dalesackrider.com` stays an alias issuer until phase 3 so existing MCP connectors keep working, then becomes a resource/console host only. |
| D-2 | **Any site may register a console, with the user's consent and no admin powers.** | Open registration (CIMD and DCR). Third-party clients always show a consent screen naming their origin and are capped below `admin`, `grants:manage` and `keys:manage`. Admins can still block a client. No "promote to trusted" path for third-party origins was requested, so it is not planned. |
| D-3 | **Access-token lifetime: not answered, so the 10-minute default applies.** | Access tokens live 10 minutes. |
| D-8 | **Stay on Cloudflare Free.** | One rate-limit rule (the combined auth-endpoint rule in §6), the Free Managed Ruleset, DDoS protection and Turnstile (free). No Pro-only rules. |
| — | **Start Phase 0: yes.** | Phase 0 code work starts in its own pull request (whoami fix, sign-in method logging, health endpoints). The Cloudflare rate-limit rule is documented there but **not** applied; it still needs Dale's separate yes. |

**Still open after 22 Nov:** D-4, D-5, D-6, D-7, and D-9. D-7, D-4, and D-5 were decided on 27 Nov 2026 (see §9b). The other proposals in §9 stay as recommendations until Dale decides.

## 9b. Decisions recorded (Dale Sackrider, 27 Nov 2026, Phoenix time)

| # | Decision | Effect on this design |
|---|---|---|
| D-7 | **Three public hostnames.** The generic product shape is `auth.<domain>`, `api.<domain>`, and `factory.<domain>`. The concrete running instance uses `dalesackrider.com`. | See §4.0. `auth.dalesackrider.com` is the issuer (already D-1). `api.dalesackrider.com` is the headless neck (`/api/v1/*`, `/mcp`, `/mcp/agents/:id`, `/api/v1/agents/:id/conversation`, webhooks). `factory.dalesackrider.com` is the first-party browser shell. This supersedes the earlier "one public host + one auth host" framing. `agent-factory.beercanlabs.com` is retired as a public advertised host. First-party Garrison moves under `factory.<domain>` rather than remaining a separate public host at `garrison.dalesackrider.com`. `factory-dashboard.dalesackrider.com` remains an issuer/resource alias until phase 3 (D-1), then redirects to the new hosts. Design only — no live DNS, Cloudflare, AWS, or production UI change in this update. |
| D-4 | **Session and refresh lifetimes as recommended.** 12 h idle / 7 d absolute session; 30-day sliding refresh for people; 90-day sliding refresh for devices. | Sessions expire after 12 hours idle or 7 days absolute, whichever first. Human refresh tokens slide for 30 days; device refresh tokens slide for 90 days. Implemented in Phase 1 Slice 3. |
| D-5 | **JWT role/grant hints, live grant check on every request.** | Access tokens may carry role and grant hints for UIs, but the resource server re-checks live grants on every request. A revocation applies immediately, not at the end of the 10-minute token lifetime. Implemented in Phase 1 Slice 5. |
| — | **First-party web heads live on `factory.<domain>`**, under one top nav switcher (name not yet vetted; "head switcher" is a placeholder). | The shell hosts: (1) Web Console (operations/admin UI); (2) Garrison (3D gaming interface — Garrison stays the 3D head); (3) a planned 2D Zelda-style game interface, separate from Garrison, under the same top nav switcher; (4) Web Chat with any factory agent via the neck's `/api/v1/agents/:id/conversation`, so agents are not Discord-only; (5) a Connect / non-web heads page with instructions for AI apps (Grok Bot, Claude, Cursor) via MCP at `https://api.<domain>/mcp`, and for downloading, installing, and authenticating the Factory CLI. The 2D game head was added 27 Nov 2026 (Dale, t376u). The shell authenticates against `auth.<domain>` and talks only to `api.<domain>` (the same neck as every other head). Loop in the factory UX Design agent to name the switcher and design the shell layout. Tracked in [#559](https://github.com/BeerCanLabs/agent-factory/issues/559). |

**Still open:** D-6 (break-glass), D-9 (speak-as hardening timing).

## 10. Proposed implementation issues

1. **Fix whoami `signedInWith` for key and MCP calls** — carry the verified credential kind through `identify()` and MCP in-process dispatch; report `amr`/`client_id`.
2. **Ledger credential kind on every request + "old credentials still in use" console view** — the data that gates each removal.
3. **Close unauthenticated health on the console host** — enforce R17 or move to the private health port.
4. **AS signing keys, JWKS and OIDC discovery** — KMS/Secrets-Manager-held ES256 keys with `kid` rotation. Tracked in [#562](https://github.com/BeerCanLabs/agent-factory/issues/562) (also closes [#527](https://github.com/BeerCanLabs/agent-factory/issues/527)).
5. **JWT access tokens (RFC 9068) from `/token` with `api` and `mcp` audiences** — dual-accept alongside `fk_at_`. Tracked in [#563](https://github.com/BeerCanLabs/agent-factory/issues/563).
6. **Durable sessions, refresh families and revocation set** — survive restarts and multiple tasks (D-4). Tracked in [#564](https://github.com/BeerCanLabs/agent-factory/issues/564).
7. **Scopes and scope-based consent; first-party client flag** — replace `mcp:full`. Tracked in [#565](https://github.com/BeerCanLabs/agent-factory/issues/565).
8. **Single resource-server verifier for `/api/v1/*` and `/mcp`** — JWT → live grants ∩ scope → Bouncer (D-5). Tracked in [#566](https://github.com/BeerCanLabs/agent-factory/issues/566).
9. **CORS driven by the client registry** — exact-origin allow-list, no credentials.
10. **First-party web shell uses Bearer tokens via a BFF on `factory.<domain>`** — cookie only at the AS (`auth.<domain>`); the shell talks only to `api.<domain>`.
11. **Device authorization grant (RFC 8628) and `/device` approval page** — incl. admin act-as with ledger.
12. **CLI: tokens instead of `cli` `fk_` keys; `factory login --device`.**
13. **Migrate Higgins (Tesla) to OAuth/device flow; revoke Stephanie's `tesla` key after 7 clean days.**
14. **Migrate Rosie (Reachy) to OAuth/device flow; revoke its key after 7 clean days.**
15. **Workload-identity token exchange for gatekeeper ingress/egress, ingest and probes; remove `FACTORY_TOKEN`.**
16. **Stop issuing non-expiring person `fk_` keys** — `POST /api/v1/keys` → device flow; admin override during migration.
17. **Remove Cloudflare Access JWT and external OIDC bearer from `identify()`.**
18. **Sign run tokens with the AS key set; verify via JWKS in control plane and gatekeeper-egress.**
19. **Turnstile on `/login` and `/device` with server-side Siteverify.**
20. **Cloudflare: one rate-limit rule on auth endpoints** *(live config — needs Dale's yes).*
21. **Cloudflare: BIC off for factory hosts, delete `/mcp` BIC rule `807657c1…`** *(live config — needs Dale's yes).*
22. **Cloudflare: delete the three factory Access apps; origin lock to Cloudflare** *(live config — needs Dale's yes).*
23. **Speak-as: signed speaker assertions / token exchange with `act` and `assurance`.**
24. **Conformance test: one credential type per route class** — fail CI on any new auth path.
25. **Demo third-party console on `mygarrison.dalesackrider.com`** — proves the any-origin story end to end.
26. **Docs: "Connect a console or device to the factory" how-to** — for adopting orgs without IT staff. The first-party Connect page on `factory.<domain>` (#559) is the in-product version of this how-to (MCP at `https://api.<domain>/mcp`, plus CLI download/install/auth).
27. **Unified first-party web shell on `factory.<domain>`** — shared top nav switcher for Console, Garrison (3D), a planned 2D Zelda-style game interface, Web Chat, and the Connect/CLI page; shell authenticates at `auth.<domain>` and talks only to `api.<domain>`. See [#559](https://github.com/BeerCanLabs/agent-factory/issues/559). Design and UX first; no live infra or production UI until an implementation PR is approved.

## 11. References

- MCP Authorization spec (2025-06-18): protected resource metadata, RFC 8707 resource indicators, PKCE, DCR / CIMD.
- OAuth 2.1 draft; RFC 6749, 7636 (PKCE), 7009 (revocation), 7591 (DCR), 8414 (AS metadata), 8628 (device grant),
  8693 (token exchange), 8707 (resource indicators), 9068 (JWT access tokens), 9449 (DPoP), 9728 (protected resource
  metadata); IETF draft "OAuth 2.0 for Browser-Based Applications".
- Cloudflare: HTTP DDoS managed ruleset, WAF managed rules, rate limiting rules, Turnstile, Browser Integrity Check,
  configuration rules.
