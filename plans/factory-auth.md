# Factory auth plan: requirements, decisions, stories

Companion to [factory-auth.json](factory-auth.json). Source: Page "Agent Factory: authorization and login redesign" (owner Dale Sackrider), Nov 1, 2026.

## Intent

The IdP answers only "who is this?". The factory answers "what may they do?": roles, grants and checks live in factory storage, enforced in factory code. The factory is headless with one way in, its API; console, MCP, CLI and desktop are clients of it.

## Requirements

- **R1** The control plane derives no role from Access claims, env email lists, or headers.
- **R2** Grants are stored durably (same backend as the config store, S3 on AWS), versioned, and survive restarts.
- **R3** Grant scope: fleet (role on the factory), agent (owner/member/agent role), skill (owner), group.
- **R4** Grant, revoke and list are API endpoints guarded by `grants.manage`; clients add no logic of their own.
- **R5** Every authz decision and every grant change is written to the ledger with actor, subject, scope, before and after.
- **R6** Machine credentials are factory API keys: shown once, stored hashed, with expiry, scopes and owner; revocation is immediate.
- **R7** `GET /api/v1/whoami` returns principal, grants and effective privileges; `GET /api/v1/authz/check` answers a single question for clients.
- **R8** Deny by default; on any store failure, fail closed.
- **R9** Bootstrap and break-glass need no Cloudflare login and print no secret.
- **R10** Conformance tests forbid new reads of `FACTORY_ADMIN_EMAILS`/`FACTORY_TOKENS` and require every route to declare a privilege.
- **R11** The trusted IdP is a first-class setup value chosen by the day-zero admin, never hardcoded; starter set Google, Meta, Cloudflare, behind one adapter interface so more can be added.
- **R12** IdP choice and its verified domain are per-deployment configuration (submind-aws, submind-gcp, any vendored copy), stored with factory config, readable via the API, and changed only by an admin with a ledger entry.
- **R13** The Access policy's admitted domain is derived from the configured IdP; a principal from any other IdP or domain is refused even if the door admits it.
- **R14** No route answers without a credential except the login page; the factory enforces this whether or not a proxy sits in front.
- **R15** One route-exception registry names every non-session route (login page, OAuth callbacks, webhooks) and how each is protected; a conformance test refuses any route outside it that declares no privilege.
- **R16** Webhook handlers fail closed: no configured signature secret means every delivery is refused.
- **R17** Health, version and metrics answer only to a verified machine API key; load-balancer probes use a private listener or a key.
- **R18** The login page lists exactly the IdPs configured at setup and is the single source of truth for web and CLI sign-in.

## Decisions

- **D1 Access is identity-only.** A verified Access JWT yields a principal with zero roles. Roles come only from the factory grant store.
- **D2 One principal per person.** Canonical id `user:<email>` (lower-case, IdP-verified); Access `sub` is stored as a secondary key. Old `cloudflare:` and `oidc:` actors migrate to it.
- **D3 Factory API keys replace FACTORY_TOKENS.** Hashed, scoped, expiring keys owned by a principal, issued and revoked through the API.
- **D4 One Bouncer call per request.** Every route asks `authorize()` with the loaded grants; env-based admin checks are deleted.
- **D5 Bootstrap once, then the API.** `FACTORY_BOOTSTRAP_ADMIN` seeds the first admin grant only when no admin exists; afterwards it is ignored.
- **D6 Unknown person gets nothing.** Authenticated but ungranted callers receive 403 except `whoami`; `viewer` is a grant, not a default.
- **D7 Role set, with one content-owner grant (Nov 1).** Roles: viewer, operator, approver (admission gate only), admin, budget-owner, content-owner (scoped to an agent or skill), and machine-only `ingest`, `gatekeeper-egress`, `gatekeeper-ingress` held by API keys. The derived `agent-owner` and `skill-owner` roles collapse into content-owner; the privilege table stays, with content type in scope.
- **D8 Open door, grants decide (Nov 1).** Access admits any identity on the agreed IdP/domain; admission to anything is a factory grant. Dale never edits Cloudflare to onboard.
- **D9 API keys bypass Access on /api/v1 (Nov 1).** Per-key hashed, scoped, expiring credentials replace the shared Access service token and `FACTORY_TOKENS`. A retained Access service token only passes the door, zero authority. Fail-closed on grant-store errors covers the lost defense in depth.
- **D10 Admin-only grants in v1 (Nov 1).** Dale is the sole admin; no admins seeded. Operators may later grant up to, never beyond, their own ceiling.
- **D11 Two agent types (Nov 1).** Personal assistants have exactly one owner (unique constraint); team agents have no owner, an accountable-lead grant and member grants.
- **D12 Transfer is for life events (Nov 1).** Owner is set at creation from the email on the new-agent form. Transfer (personal only) is a dedicated two-phase endpoint for departures and promotions, not bootstrap. Provisioning or configuring an agent needs operator/admin config and model grants, not ownership.
- **D13 Unknown principals rejected (Nov 1).** A grant to a mistyped or nonexistent principal is refused by the store before any write: 403, no orphan ledger entry.
- **D14 Channels are a client problem; one key per device family (Nov 1).** A person reaching Higgins via Discord today (identity link) or a Tesla tomorrow holds the same grants; Higgins runs inside the factory and does not authenticate. Decided: one API key per device family, owned by the person (for example Stephanie's Tesla key, scoped talk-to-higgins).
- **D15 Read-only while a transfer is pending (Nov 1).** On a personal-agent transfer the old owner drops to read-only when the pending transfer starts, not at finalize. Accepted: the new owner gets write and the old grant is revoked. Declined or rolled back by the sweeper: the old owner's write access is restored.
- **D16 IdP is a setup value, per deployment (Nov 1).** The day-zero or day-one admin chooses which IdP the factory trusts during initial setup; the Access policy widens to the domain that IdP verifies. Starter IdPs: Google, Meta, Cloudflare. Applies to submind-aws, submind-gcp (currently non-functional) and any company deploying its own copy.
- **D17 Skill-driven egress is a follow-on epic (Nov 1).** Wiring skill routes into agent policy is out of scope for this epic and tracked as the linked follow-on epic, Skill-driven egress policy.
- **D18 No unauthenticated endpoints (Nov 1).** The factory itself enforces it, not the proxy. The only deliberate open route is the human login page; its OAuth callbacks are state-protected, not open. Every other route needs a session, a verified API key, a run token, or a verified webhook signature.
- **D19 Factory-served login page and session (Nov 1).** Web users land on the factory's own login page with one button per IdP configured at setup (D16). After OAuth the factory issues its own session. Cloudflare Access becomes optional, one IdP among others.
- **D20 CLI signs in through the login page (Nov 1).** `factory login --url <factory-base-url>` opens the login page in a browser; the callback returns the token to the CLI on a local loopback port, as `cloudflared` does today but pointed at the factory.
- **D21 Retire the CLI discovery file (Nov 1).** `GET /.well-known/factory-cli` (`control-plane/src/app.ts:2056`, built from `FACTORY_OIDC_*` in `auth/src/discovery.ts`) is redundant. Retire it, or fold its content into the login page's IdP list; it does not remain a separate pre-credential route.
- **D22 Named exceptions, failing closed (Nov 1).** Health and version need a machine API key. GitHub and generic `/api/v1/hooks/:id` webhooks are signature-verified exceptions that refuse every delivery when no signature secret is set. OAuth callbacks stay state-protected. `/ui` and console SPA assets are served only to a signed-in session; the login page carries its own minimal assets.
- **D23 Unverified keys refused first; /mcp included (Nov 1).** A request presenting an API key is verified before any other handling and refused on failure. `/mcp` uses the same key path as `/api/v1`.
- **D24 Content-owner rights are fixed (Nov 1).** Ownership is metadata naming which agents or skills a person controls. Rights: version, configure, decommission, transfer, and grant content roles on that item to others.
- **D25 One budget-owner per factory; admin is backup (Nov 1).** Budget-owner is a grantor role covering AI model spend and cloud resource spend, with no departments in v1. The admin may act as budget-owner in small deployments and may override or approve budget.
- **D26 Skills are person-owned; visibility rules (Nov 1).** Every skill has a person holding content-owner. A private skill can be assigned only to agents its owner has authority over; a public skill can be adopted by anyone.
- **D27 Approver is the admission gate only (Nov 1).** Any signed-in user may submit an agent or skill draft. Three parallel gates run: automated security scan, automated compliance check, and budget availability (has the budget-owner allocated budget). The approver admits content once all three pass; the submitter has no say over budget, and no allocation means no admission.
- **D28 Skills spend the invoking agent's budget (Nov 1).** Skills hold no budget of their own; their spend counts against the agent that calls them.
- **D29 Run-time holds go to the content side (Nov 1).** Personal agent: its one owner clears holds. Team agent: any member may clear a hold. The old requester and approver hold paths are removed.
- **D30 Team lead named at submission (Nov 1).** The submitter of a team agent names its lead and does not become lead automatically; a personal agent's submitter becomes its owner.
- **D31 Skill hold policy and model binding (Nov 1).** A skill declares which of its actions need a human by default; the owner may make it stricter. Each skill's model is a factory-side binding the skill owner picks from evals, swappable and inherited by every calling agent; an agent's own model stays an ops setting.
- **D32 Pre-provision by email (Nov 1).** An admin creates a grant naming an email before the person first signs in; on login the grant is found. Ungranted callers still get 403 with no shadow record (D6).

## Stories (epic: factory-auth)

Story-breaker creates these as issues only after this plan is merged **and** Dale has completed the product-flow walkthrough below; each issue links back here.

- **S1 Canonical principal:** Access JWT maps to `user:<email>` with zero roles; `sub` recorded; `cloudflare:`/`oidc:` strings in config-store owners, identity links and group members normalize to `user:<email>`, and content-owner grants reference it; tests cover email case and service-token CN.
- **S2 Grant store:** Versioned store on the config backend with fleet/agent/skill/group scopes, expiry, pending states; one `content-owner` grant type scoped `{kind: agent | skill, id}`; unique owner constraint on personal agents and on skills; grants may name an email before first login (pre-provisioning, no shadow records); unknown subject rejected before write with no ledger entry; fails closed on read error; e2e restart test.
- **S2b Agent types and ownership:** `kind: personal | team` on agents; personal: the submitter becomes the one content-owner; team: lead named at submission (submitter not lead automatically), members are separate grants, no owner, any member may clear holds; existing agents classified in migration; provisioning works with operator/admin config grants alone.
- **S3 Grants API + MCP tools:** Routes in the API table guarded by `grants.manage` (fleet roles admin-only in v1); a content-owner may grant content roles on their own items; a private skill may be granted only to agents its owner has authority over; admin pre-provisions by email; ceiling check rejects any grant above the granter's level; MCP tools call the same functions; 403 names required role.
- **S3b Content-ownership transfer:** Applies to personal agents and skills; dedicated endpoint writes pending-revoked/pending-accepted in one transaction; target notified on their channel; accept/decline endpoints; sweeper rolls back stale pendings; team agents return 409; old owner is read-only from transfer start (write calls 403); on accept the new owner gets write and the old grant is revoked; on decline or sweeper rollback the old owner's write is restored, all ledgered.
- **S4 Single enforcement:** Route table with declared privilege per route; the only routes without one are those in the route-exception registry (S14); all admin helpers call `authorize()`; conformance test fails on a route with no privilege or any `FACTORY_ADMIN_EMAILS` read; `DERIVED_ROLE_PRIVILEGES` agent-owner and skill-owner replaced by one content-owner rule; approver privileges limited to content admission.
- **S5 Factory API keys:** Issue/rotate/revoke/list; owned by a principal; one key per device family (for example a person's Tesla key scoped talk-to-higgins); hashed at rest; shown once; expiry and scopes capped by owner's grants; revoked key refused on next request; never logged.
- **S5b API-key Access bypass:** Landing zone bypasses Access on `/api/v1` only for requests carrying a factory key, still only via the proxy; conformance test holds no other bypass besides webhooks; keyless requests still get the Access challenge.
- **S6 Bootstrap + break-glass:** Bootstrap only when no admin; setup asks the day-zero admin to choose the trusted IdP (Google, Meta or Cloudflare) and its domain and stores it per deployment, ledgered; setup refuses to finish without one; one-off recovery command; break-glass key use ledgered; no secret printed by scripts.
- **S7 Audit:** All ledger actions above emitted, plus `CONTENT_SUBMITTED`, `GATE_PASSED`/`GATE_FAILED`, `CONTENT_ADMITTED`, `BUDGET_ALLOCATED`, `HOLD_CLEARED` (with who cleared it) and `OWNER_CONVERTED`; `AUTHZ_DENIED` includes privilege and resource; secret-scan test passes.
- **S8 Migration import + shadow:** Importer converts env lists and identity-link roles, and takes existing owners from S18; shadow mode also compares hold routing and owner checks; shadow mode ledgers mismatches; zero mismatches for 7 days before cutover.
- **S9 Clients:** Console uses `whoami` and `authz/check` for gating and shows all roles, adds People and Keys views, a submission and draft-status view, a holds inbox for content owners and team members, an approver admission queue and a budget-owner allocation view; CLI gets `factory grants` and `factory keys`; desktop uses the same calls.
- **S10 Ops repo cutover:** `submind-aws` scripts use factory API keys; `FACTORY_TOKENS`/`FACTORY_TOKEN` and shared Access service token retired; deploy check proves an anonymous request gets the factory login page (not a Cloudflare 302) and every other route refuses it.
- **S11 Widen the door:** After cutover, if Cloudflare remains a configured IdP the Access policy admits the IdP and domain configured at setup (otherwise the chosen IdP is configured on the factory login page per D16/D19), applied per landing zone (AWS now, GCP when it works); the factory refuses principals from any other IdP or domain; an ungranted new identity gets 403 everywhere but `whoami`; onboarding needs no Cloudflare change.
- **S12 Login page and session:** Factory serves a login page listing the IdPs configured at setup; OAuth with state protection; issues a factory session; console and `/ui` served only to a session; ledgered sign-in.
- **S13 CLI login flow:** `factory login --url` opens the login page; token returned on a loopback port; no pre-credential fetch; works for each starter IdP.
- **S14 Route-exception registry + test:** One registry names the login page, OAuth callbacks and webhooks with their protection; conformance test fails any other route that is reachable without a credential or declares no privilege.
- **S15 Webhooks fail closed:** GitHub and generic `/api/v1/hooks/:id` refuse every delivery when no signature secret is set; signature checked before any other handling; e2e tests for missing, bad and good signatures.
- **S16 Health behind keys:** `/`, `/healthz`, `/api/v1/health` and metrics need a machine API key; load-balancer probes keep working on a private listener or key.
- **S17 Retire CLI discovery:** `/.well-known/factory-cli` and `auth/src/discovery.ts` removed, or replaced by the login page's IdP list; CLI no longer calls it.
- **S18 Owner conversion:** Before cutover, every production owner string (`cloudflare:<email>` in the config store) becomes a content-owner grant on `user:<email>`; a dry-run report must show no live agent left without an owner before the real run.
- **S19 Budget-owner role:** One budget-owner per factory, a grantor not a reviewer; allocates AI model budget (`budgetUsd`, `policies/budget`) to agents outside the submission flow; admin can act as backup and override; skills hold no budget and spend against the invoking agent.
- **S20 Content submission + admission gates:** Any signed-in user submits an agent or skill draft; it stays pending while three parallel gates run: automated security scan, automated compliance check, budget availability (allocation exists); approver admits only when all pass; submitter cannot set budget; replaces admin-decided registration and adoption.
- **S21 Interview agent drafting:** An interview agent helps non-technical users build a draft, which enters S20 unchanged.
- **S22 Holds to content side:** Run-time holds route to the personal agent's owner or to any team member; requester and approver hold paths removed; e2e covers both agent types.
- **S23 Skill default hold policy:** A skill declares which of its actions need a human; adoption applies it as the default; the owner may only make it stricter.
- **S24 Per-skill model binding:** Factory-side binding from skill to model, set by the skill owner from evals, swappable, inherited by every calling agent; not in the manifest; agent model stays an ops setting.

## Migration order

- **1. Shadow** Ship the grant store and import: each `FACTORY_ADMIN_EMAILS` entry becomes an admin grant, each `FACTORY_TOKENS` entry becomes an API key principal with its roles, identity-link roles become grants. Old and new decisions both computed; mismatches ledgered.
- **2. Cut over** Bouncer reads only grants. Env lists still parsed but only to warn.
- **3. Keys** Ship the Access bypass for factory-key requests on `/api/v1` (TSK-286 pattern, conformance-guarded). Issue keys for deploy checks, identity-link and break-glass; update `submind-aws` scripts; retire `FACTORY_TOKENS`/`FACTORY_TOKEN` and the shared Access service token.
- **4. Door** Q1 and Q5 are decided: if Cloudflare remains a configured IdP, widen the Access policy to the IdP and domain configured at setup (D16); otherwise configure the chosen IdP on the factory login page (D16, D19). Either way admission is decided by grants. Only after cutover (step 2), so an ungranted newcomer meets a 403.
- **5. Remove** Delete env reads and the `cloudflare-service:` mapping; conformance guards stop them coming back.
- **6. Login page** Ship the factory login page and session alongside the Access path; move the CLI to `factory login --url`; put health behind keys and the console behind a session; retire `/.well-known/factory-cli`; then make Access optional per D19.

## Follow-on epic gaps: skill-driven egress

- **E1** Agent policy can hold routes no skill justifies, and those routes skip person-level role checks.
- **E2** Adopting a skill does not grant its routes, so an admin edits the policy separately.
- **E3** Nothing enforces a skill action's method, path or hold at egress; the gatekeeper sees only routes and hosts.

## Product flows to walk through before approval

1. Onboarding a new human.
2. Issuing, rotating and revoking a device key: Dale's wife reaching Higgins from her Tesla with a key owned by her principal, scoped such as talk-to-higgins (one key per device family, decided in D14).
3. Transferring personal-agent ownership.
4. Granting team membership.
5. Break-glass use.
6. Lockout recovery.
7. Console, MCP and CLI gating through `whoami` and `authz/check`.
