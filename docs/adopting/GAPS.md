# Adoption gaps: what makes the factory hard or impossible to adopt today

*Reference adopters: a ~400-person church running a licensed preschool (100+ children), and a local Sleep in Heavenly Peace (SHP) chapter. Neither has IT staff.*

This file merges five independent reviews (core product, platform/connectors/cost/hosting, security & child safety, church + preschool, SHP chapter). Overlapping findings are **deduplicated** into one consolidated gap (`G-xx`); the original finding IDs (`CORE-`, `GAP-P`, `SEC-`, `CHURCH-`, `SHP-`) are kept as cross-references so the evidence in the [detailed findings](#detailed-findings-by-review) below can be traced. Every detailed finding states what the adopter is trying to do, why it fails today (with file / endpoint citations), and a suggested fix.

**Severity**

- **Blocker**: the organization cannot start, or a core, everyday workflow is impossible or unsafe.
- **Major**: they can start narrowly, but a predictable need is missing, risky or costly enough to stall adoption.
- **Minor**: polish, copy, or follow-on work that would not stop a carefully scoped hosted pilot.

---

## Top 10 blockers, in plain language

1. **There is no "sign up your organization."** The factory runs one organization per installation, and the only one running is BeerCanLabs'. A church or chapter can't create its own space, and two organizations can't safely share one (admins would see each other's agents, logs and costs). *(G-01)*
2. **Setting up a factory takes a cloud engineer.** Terraform, AWS accounts, certificates, DNS, Cloudflare and sign-in configuration. No church office or volunteer chapter will do this. *(G-02)*
3. **You can't add an agent from the dashboard.** Creating the "virtual staff" needs the factory team or a developer (API call, a text-command builder, or an interview that isn't in the dashboard). *(G-03)*
4. **People can't reach agents where they already are.** No email, text message, website chat, Slack or Teams. Only the dashboard, AI desktop apps, or Discord. *(G-04)*
5. **Approvals only happen in the dashboard or Discord, and some need a GitHub account.** Directors and volunteers can't approve a message by email or text, and outgoing messages to families are not held unless someone configures it. *(G-05)*
6. **Children's data has no safe home.** No parental consent, parent review or deletion; children's and families' details go to outside AI providers with no child-data path; "kid-safe mode" sets tone but doesn't filter content. *(G-06)*
7. **No connectors for the systems churches and preschools run on.** Planning Center, Breeze, Realm, Brightwheel, Procare and similar. *(G-07)*
8. **No connection to SHP's national Chapter Portal, and no official path with SHP national.** Bed requests, deliveries and stats live there. *(G-08)*
9. **Microsoft 365 isn't supported as a first-class tool.** Many churches run on it for mail, calendar and files. *(G-09)*
10. **"Who is speaking" for voice/assistant clients is asserted by the client, not proven.** Fine for a household; not enough for child-facing or kiosk use. *(G-10)*

**What an adopter can do anyway:** ask the factory team to host a dedicated factory, start with one internal, adult-only, no-sensitive-data agent (bulletin drafts, volunteer reminders from a shared Google Sheet, donor thank-you drafts), keep a person approving every outgoing message in the dashboard, and keep children's records, recipient addresses and background-check data out of the factory entirely.

---

## Consolidated, prioritized gap list

| ID | Severity | Gap | Cross-refs |
|---|---|---|---|
| G-01 | Blocker | No self-serve organization; single-tenant (no isolation, billing or admin boundary per org) | CORE-1, GAP-P1, GAP-P2, CHURCH-1 |
| G-02 | Blocker | Deploying a factory needs cloud/infra skills (Terraform, AWS, DNS, IdP, Cloudflare); Azure bind is a stub | CORE-2, GAP-P3, GAP-P17 |
| G-03 | Blocker | Dashboard cannot create an agent; Agent Builder is a command prompt; S21 interview not in console | CORE-3, CHURCH-5, CHURCH-17 |
| G-04 | Blocker | No email, SMS, web-chat, Slack or Teams channel to reach agents (Discord is the only chat ingress) | CORE-5, GAP-P6, GAP-P7, CHURCH-3, SHP-2 |
| G-05 | Blocker | Approvals: console/Discord only; decision holds keyed to GitHub logins; person-contacting egress not held by default; config-change approvals blind in console | CORE-4, GAP-P12, SEC-5, SHP-17, CHURCH-3, CHURCH-16 |
| G-06 | Blocker | Children's data: no consent/review/deletion, no child-data model path or redaction, kid-safe is tone-only | SEC-1, SEC-2, SEC-3, CHURCH-4, SHP-3 |
| G-07 | Blocker | No church-management or preschool connectors (Planning Center, Breeze, Realm, Brightwheel, Procare) | GAP-P5, CHURCH-2 |
| G-08 | Blocker | No SHP Chapter Portal (Salesforce) connector; no official path through SHP national | SHP-1, SHP-4 |
| G-09 | Blocker (M365 orgs) | Microsoft 365 is not a productized sign-in or tool connector | GAP-P4, CHURCH-6 |
| G-10 | Blocker (child-facing / kiosk use) | Speak-as trusts the client's assertion of who is speaking | SEC-4 |
| G-11 | Major | Sensitive records (preschool files, recipient addresses, donor files, background checks) get no special handling | SEC-6 |
| G-12 | Major | No invitation flow; sign-in limited to Google/Meta/Cloudflare/OIDC, set up by API; no email magic link | CORE-6, CORE-7 |
| G-13 | Major | Platform OAuth apps (Google etc.) must be created by a technical admin; Google connect not turnkey | GAP-P9, CHURCH-11, SHP-10 |
| G-14 | Major | Google Sheets and Excel are not first-class systems | GAP-P8, SHP-10 |
| G-15 | Major | Factory-wide budgets alert but do not stop spending | GAP-P10 |
| G-16 | Major | Cost: reference AWS landing zone has a high fixed cost; nonprofit credits external; cost unexplained in org terms | GAP-P11, GAP-P14, SHP-20 |
| G-17 | Major | Keys: console issues keys only for yourself (no owner picker, no agent scoping); offboarding leaves API keys and domain grants | CORE-8, CORE-9, SEC-10, SEC-17, SHP-12 |
| G-18 | Major | Sessions are lost on every restart; MFA depends on the IdP | CORE-10, CHURCH-13, SEC-20 |
| G-19 | Major | Roles, groups and screens use engineering vocabulary; viewer/operator too powerful as volunteer stand-ins; groups mistaken for orgs | CORE-11, CHURCH-9, CHURCH-19, SHP-21, SEC-16, GAP-P19 |
| G-20 | Major | No templates for common nonprofit roles | CORE-12 |
| G-21 | Major | No enforced memory retention or per-person export/erasure | CORE-13, SEC-8 |
| G-22 | Major | No support path, status page or incident/breach workflow for adopters | CORE-15, GAP-P13, CHURCH-13, SEC-12 |
| G-23 | Major | Admins can read any conversation (pastoral, child) with only a ledger row | CHURCH-7, SEC-7 |
| G-24 | Major | No parent-safe door (parents must not get factory accounts); household relationships are the only kid/adult model | CHURCH-8, SEC-11 |
| G-25 | Major | Speak-as administration has no console UI | SEC-9 |
| G-26 | Major | No board / licensing / subprocessor (DPA) packet | CHURCH-14, SEC-13 |
| G-27 | Major | Schedules: default time zone America/Los_Angeles; hard to see; no org obligations calendar | CHURCH-10, CHURCH-20, SHP-18, SHP-22 |
| G-28 | Major | Giving and finance connectors missing; unofficial money tools easy to wire badly | CHURCH-12, SHP-5, SHP-14 |
| G-29 | Major | Nothing stops card numbers or secrets being typed into chat | SEC-14 |
| G-30 | Major | No Facebook/Instagram connector; brand and photo rules not enforced at posting | SHP-6, SHP-16 |
| G-31 | Major | No volunteer-signup connector (SignUpGenius, Golden Volunteers) | SHP-7 |
| G-32 | Major | No maps/delivery routing and no safe way to share addresses | SHP-8 |
| G-33 | Major | No e-signature path for waivers and releases | SHP-9 |
| G-34 | Major | Team work needs shared memory; personal agents keep per-person notebooks | SHP-11 |
| G-35 | Major | No Spanish (or other language) support for family messages | SHP-13 |
| G-36 | Major | Chapter President's Report and national stats not in the loop | SHP-15 |
| G-37 | Minor | `whoami` reports `signedInWith: "cloudflare-access"` for fk_ API-key calls | CORE-14, SEC-15 |
| G-38 | Minor | Credential catalog unfinished, unapproved and aimed at developers (LinkedIn/X/GitHub/Health present, church tools absent); seed noise | CHURCH-15, CHURCH-18, GAP-P15, GAP-P16, GAP-P18 |
| G-39 | Minor | Cloudflare Browser Integrity Check blocks default script user agents except on `/mcp` | CORE-16 |
| G-40 | Minor | CLI install is macOS only | CORE-17 |
| G-41 | Minor | Backup/restore is an admin API, not a button; memory and connections not included | CORE-18 |
| G-42 | Minor | A shadow inventory or waitlist will drift from the official one | SHP-19 |
| G-43 | Minor | `assurance` and `via` are easy to misuse in tools | SEC-18 |
| G-44 | Minor | No expiry reminders for keys or speak-as grants | SEC-19 |
| G-45 | Minor | Ledger readable by every viewer; snapshots may hold emails | SEC-21 |

Severity notes from the merge: where reviews disagreed, the higher severity was kept for the consolidated gap, except `whoami` (G-37), rated Minor here because it misleads audits but blocks no workflow (SEC-15 and CORE-14 rated it Major). CORE-9 (API keys survive offboarding) was folded into G-17.

## Suggested order of work for the factory team

1. **Hosted dedicated factory per organization** (G-01, G-02 as a service, not self-serve yet), with an honest cost sheet (G-16) and a support contact (G-22).
2. **Console "New agent" wizard with templates** (G-03, G-20) and **invitations + email sign-in** (G-12), plain-language roles (G-19).
3. **Email approval adapter and default-hold for person-contacting egress**, approvers by email not GitHub (G-05), then **email/SMS ingress** (G-04).
4. **Operator-owned Google app + Sheets system** (G-13, G-14), then Microsoft 365 (G-09) or Planning Center / Chapter Portal (G-07, G-08), chosen by the first real adopter.
5. **Child-data policy stays "do not put it in the factory"** until G-06, G-10, G-11, G-21 and G-23 close.
6. Quick fixes: persist sessions (G-18), revoke keys on offboarding (G-17), fix `whoami` (G-37), default time zone from org setting (G-27).

---

## Detailed findings by review

The five source reviews follow unedited (headings shifted one level), so each finding keeps its evidence and suggested fix.


### Review: Core product: accounts, sign-in, people, keys, agents, operations (`GAPS-core.md`)
Format: ID · Severity · What the adopter is trying to do · Why it fails today (evidence) · Suggested fix

### Blocker

#### CORE-1 · Blocker · No self-serve organization (tenant); one factory = one organization
- **Trying to:** Sign up "Grace Church" or "SHP Chapter #123" and get their own space.
- **Why it fails:** There is no tenant/organization concept anywhere in the control plane (no `org`/`tenant` in `packages/control-plane/src`; principals, grants, agents, spend and ledger are all factory-global). The only running factory (factory-dashboard.dalesackrider.com) is Dale's. An org would either share Dale's factory (every admin sees every agent, ledger and spend) or need its own deployment.
- **Fix:** Either (a) a hosted multi-tenant mode with `orgId` on principals, grants, agents, spend, ledger and connections, plus org-scoped admin; or (b) a supported "one factory per org" managed offering run by the factory team. Until then, adoption requires the factory team to host.

#### CORE-2 · Blocker · Standing up a factory needs cloud/infra skills
- **Trying to:** Get a factory running without IT staff.
- **Why it fails:** Deployment is a Draftsman interview plus a landing-zone bind (`landing-zones/PATTERNS.md`, `landing-zones/aws|azure|gcp|compose`, `blueprints/`), env vars like `AWS_ACCOUNT_ID`, `FACTORY_ECR_REPO_URI` (README "Deployment Configuration"), an OIDC client (`PUT /api/v1/setup/idp`), DNS and an edge (Cloudflare). None of this is doable by a church admin.
- **Fix:** A managed hosted offering, or a one-click installer that provisions everything and ends at a "sign in with Google" screen.

#### CORE-3 · Blocker · Console cannot create an agent
- **Trying to:** "Add an office assistant" from the dashboard.
- **Why it fails:** Creating an agent is `POST /api/v1/agents` (admin; `agent-creation.ts`) or the S21 interview at `/api/v1/submissions/interview` (`interview-draft.ts`), or the headless Agent Builder cartridge (`agents/staff/agent-builder`) driven by text commands. The console (`packages/console/src/api/client.ts`) has no create-agent or interview call; Cartridge Studio is a developer tool. The interview also asks for a "factory id, e.g. user:dale" and "skill ids".
- **Fix:** A console "New agent" wizard on top of the S21 interview, with a people picker instead of ids, a template gallery, and plain-language skill choices.

#### CORE-4 · Blocker · Approving a decision an agent asks for requires a GitHub account
- **Trying to:** Preschool director approves "send this enrollment email to 40 families?"
- **Why it fails:** Decision holds name approvers as GitHub logins and only a person whose linked non-bot GitHub login is on the list may decide (`decision-holds.ts` header, GAP-259). Held egress actions can be approved in the console Approvals view or by Discord DM reply only; Slack, Teams, email, SMS and links are "Not built" (`docs/APPROVAL_ADAPTERS.md`). Configuration-change approvals in the console are "blind" (same doc).
- **Fix:** Approvers named by factory principal (email), and an email/SMS one-tap approval adapter showing the full outgoing message.

#### CORE-5 · Blocker · No way to talk to an agent from tools these orgs use
- **Trying to:** Staff and volunteers text, email or use a web chat to reach "the church office assistant".
- **Why it fails:** The only chat ingress is Discord (`packages/gatekeeper/src/ingress/discord.ts`, `http.ts`). Otherwise people use the console Workbench, the CLI (macOS install only, `docs/CLI.md`), or an MCP client (Claude Desktop, Cursor, ChatGPT). There is no email, SMS, website widget, Slack or Teams ingress.
- **Fix:** Email and SMS ingress first (most volunteer-friendly), then a public web-chat widget with kid-safe/anonymous mode, then Slack/Teams.

### Major

#### CORE-6 · Major · No invitation flow
- **Why:** People & Access can "Add person" (name + email) and grant roles (`PeopleView.tsx`, `POST /api/v1/principals`, `/api/v1/grants`), but no invite email is sent; the admin must tell the person the URL and that they must sign in with exactly that email via a configured provider.
- **Fix:** Send an invite email with a sign-in link; show "invited / joined" status.

#### CORE-7 · Major · Sign-in providers limited and set up by API
- **Why:** Login supports Google, Meta, Cloudflare, generic OIDC (`login.ts` LABELS). Provider setup is `PUT /api/v1/setup/idp` with a client id/secret the org must create in Google Cloud or Entra. Many volunteers use personal Yahoo/iCloud/Outlook.com email; there is no email magic link.
- **Fix:** Email magic-link sign-in; a guided provider setup screen; Microsoft personal accounts.

#### CORE-8 · Major · Console "Your API Keys" only issues keys for yourself
- **Why:** `issueKey(deviceFamily)` sends no owner (`console/src/api/client.ts`); device families cli/mcp/service/automation; no agent scoping or owner picker in UI. Issuing a key for another person (e.g. a kiosk or a shared front-desk tablet) needs an admin session calling `POST /api/v1/keys` with `owner` by hand. API keys cannot manage keys (403).
- **Fix:** Owner picker, agent scoping and expiry in the Keys view for admins.

#### CORE-10 · Major · Sessions are lost on restart
- **Why:** `SessionStore` is in memory; "A restart signs users out" (`login.ts`). Each deploy signs every volunteer out.
- **Fix:** Persist hashed sessions in the config store.

#### CORE-11 · Major · Roles and screens use engineering vocabulary
- **Why:** Fleet roles viewer/operator/approver/admin/budget-owner; agent roles member/accountable-lead/content-owner/agent-member (`people-model.ts`); nav items "Fleet Command", "Systems & Egress", "Cartridge Studio", "Immutable Ledger", "Triage & Incidents" (`Sidebar.tsx`). No "simple mode".
- **Fix:** Plain-language labels and a role preset per job (Office admin, Ministry lead, Volunteer, Board viewer).

#### CORE-12 · Major · No templates for common nonprofit roles
- **Why:** `agents/staff` has agent-builder, factory-manager, personal-trainer; `agents/examples` has echo-agent, llm-summarizer, starter-python. Nothing for office assistant, volunteer scheduler, donor thanks, intake.
- **Fix:** A template gallery with prewritten souls, skills, egress and approval defaults per role.

#### CORE-13 · Major · No data-retention or deletion controls for agent memory
- **Why:** Ledger checkpoint retention is a deploy env (`FACTORY_LEDGER_RETENTION_DAYS`, default 365, `ledger/src/checkpoints.ts`); there is no per-agent memory retention setting or "delete this family's data" request flow in the API or console. Agent retire goes to `RETIRED_PENDING_PURGE` (`app.ts`) but that is whole-agent.
- **Fix:** Per-agent retention policy, per-person data export/delete, and a documented purge timeline.

#### CORE-14 · Major · whoami mislabels API-key calls
- **Why:** `GET /api/v1/whoami` reports `signedInWith: "cloudflare-access"` for fk_ Bearer key calls. Confusing when an org admin checks "how is this device signed in".
- **Fix:** Report `api-key` with the key id prefix.

#### CORE-15 · Major · No support path
- **Why:** No in-product help, status page, or support contact in the console or docs. Triage & Incidents is for operators.
- **Fix:** Help link, support email, status page, and a "something's wrong" button that files a ticket with context.

### Minor

#### CORE-9 · Minor · Revoking a person leaves their API keys in place
- **Why:** `POST /api/v1/principals/:id/revoke-access` (People & Access → "Revoke all access") removes grants, groups, sessions and CLI tokens but "Long-lived fk_ API keys are NOT revoked (they hold no power without grants)" (`grants-routes.ts` #436). A remaining domain-wide grant (`domain:church.org`) could still give the key's owner access if their email stays on the domain.
- **Fix:** Option (default on) to revoke keys during offboarding; show a person's keys on their People row.

#### CORE-16 · Minor · Cloudflare Browser Integrity Check blocks some scripts
- **Why:** Default Python-urllib User-Agent gets error 1010 on the dashboard host except `/mcp`. Affects anyone wiring a spreadsheet script or Zapier-like tool to the REST API.
- **Fix:** Document it; relax BIC on `/api/v1/*` for Bearer callers.

#### CORE-17 · Minor · CLI install is macOS only
- **Why:** `docs/CLI.md` "Install (macOS)". Church offices often run Windows or Chromebooks.
- **Fix:** Windows installer or npm-based install; most adopters should never need the CLI.

#### CORE-18 · Minor · Backup/restore is an admin API, not a button
- **Why:** `GET /api/v1/config/export` (admin) exports agent configuration history; no import-from-export button in the console; memory and connections are not part of it.
- **Fix:** "Download backup" and "Restore" in the console, documented scope.


### Review: Platform: connectors, cost, hosting (`GAPS-platform.md`)
**Scope:** gaps that make adoption by a mid-sized church (with preschool) or a Sleep in Heavenly Peace chapter difficult or blocked, assuming no IT staff. Companion drafts: `connectors-and-integrations.md`, `costs-and-billing.md`, `hosting-and-setup.md`.

**Severity**

- **Blocker** — the org cannot start, or a core daily workflow is impossible.
- **Major** — they can start in a narrow way, but a predictable need is missing or unsafe/expensive enough to stall adoption.
- **Minor** — polish, copy, or a follow-on that should be fixed but would not stop a hosted pilot.

Each gap states what the adopter wants, why it fails today (with a repo citation), and a suggested fix. These are planning notes, not an implementation commitment.

---

### Blockers

#### GAP-P1 — No self-serve organization or factory

**Wanted:** a church secretary or chapter president signs up, names the organization, invites two staff, and gets a dashboard.

**Why it fails today:** the product is a deployable stack, not a signup service. There is no organization resource, no public registration API, and no “create tenant” path. The live dashboard at `https://factory-dashboard.dalesackrider.com/ui` is one already-provisioned factory. Landing-zone bring-up is Terraform (`landing-zones/aws/README.md`: AWS account, ACM certificate, private ops repo, `terraform apply`). Login and IdP setup (`GET`/`PUT /api/v1/setup/idp`, `packages/control-plane/src/idp-config.ts`; `packages/control-plane/src/login.ts`) only work after a factory exists and an operator can already authenticate.

**Suggested fix:** offer a **hosted dedicated factory** playbook (operator provisions, customer only signs in) as a near-term service; separately, design an Organization resource and a self-serve create flow if the product should become multi-customer SaaS.

---

#### GAP-P2 — Single-tenant only (no isolation or billing per org)

**Wanted:** one hosted platform that serves many churches and chapters, with each seeing only its people, mail, files, agents, and invoice.

**Why it fails today:** one control plane owns one ledger, one systems catalog, one Keymaster secret space, and one FinOps report (`packages/control-plane/src/spend.ts`, `GET /api/v1/spend/report`). Groups (`/api/v1/groups`, `packages/control-plane/src/group-routes.ts`) are RBAC lists, not tenants. Putting two legal organizations on one factory would share platform OAuth clients, admin surfaces, and spend. There is no per-org invoice object and no way to charge infrastructure to a customer in-product (`costs-and-billing.md`).

**Suggested fix:** do not colocate adopters on BeerCanLabs’ factory. For a true hosted SaaS, add a tenant boundary around secrets, grants, systems, ledger visibility, and `spend` (hard isolation, not a UI filter), plus billing accounts. Until then, one AWS (or Compose) deployment per org, invoiced outside the product.

---

#### GAP-P3 — A non-technical org cannot deploy the reference factory

**Wanted:** “We have a domain and a debit card; walk us through it.”

**Why it fails today:** the AWS landing zone requires Terraform, a VPC, ECS, IAM, EFS, S3 Object Lock, Secrets Manager, an ACM cert in `us-east-1`, CI deploy roles, and usually Cloudflare Access (`landing-zones/aws/README.md`, `landing-zones/aws/cloudflare.tf`). Azure is a one-page interview note with no Terraform (`landing-zones/azure/README.md`). Compose is easier (`landing-zones/compose/README.md`) but still requires Docker Engine 26+, secret files, price JSON, and an acceptance of host-level trust. None of this is exposed as a console wizard.

**Suggested fix:** treat deployment as an operator responsibility (GAP-P1). If self-deploy remains a goal, it needs a radically smaller “starter host” and a documented, non-Terraform happy path — not more variables on the current landing zone.

---

#### GAP-P4 — Microsoft 365 is not a productized connector

**Wanted:** agents that use Outlook mail and calendar, OneDrive/SharePoint, Teams, and Excel — including mailboxes obtained through [Microsoft’s nonprofit grant](https://www.microsoft.com/en-us/nonprofits/offers-for-nonprofits).

**Why it fails today:** `systems_import` in `landing-zones/aws/variables.tf` seeds Google mail/calendar/drive, not Graph. `INSTRUCTION_CATALOG` (`packages/keymaster/src/catalog.ts`) has no Microsoft entry. There is no Microsoft app-setup provider (`packages/control-plane/src/app-setup-providers.ts` registers GitHub and Discord). The schema *allows* an `oauth-user` system aimed at `login.microsoftonline.com` (`packages/contract/src/system.test.ts`), and generic OIDC can sign *people* into the dashboard (`idp-config.ts`), but agents still have no Graph route.

**Suggested fix:** add official system definitions (Outlook, Calendar, OneDrive, optionally Teams and Excel) with a Keymaster catalog entry and a once-per-factory Entra app, mirroring the Google OAuth client pattern (`shared/<id>/oauth-client`, `packages/keymaster/src/connections.ts`). Ship held writes on send/delete. Until then, only accept Google-workspace pilots, or have the factory team do a one-off Graph system (still undocumented for the adopter).

---

#### GAP-P5 — No church-management or preschool systems

**Wanted:** Planning Center, CCB/Breeze/FellowshipOne, and preschool tools such as Procare or Brightwheel — people, children, check-in, rooms, tuition, parent messages.

**Why it fails today:** none of those names appear as systems, catalog sources, or app-setup providers under `packages/`, `landing-zones/`, or `docs/`. A generic `POST /api/v1/systems` proposal could wrap a vendor API, but that is an engineering task plus an approval (`packages/control-plane/src/systems.ts`), and there is no preschool-specific data policy (holds, least privilege, retention) built in.

**Suggested fix:** pick one or two high-demand vendors (Planning Center is the usual church starting point; one preschool SIS), publish a curated system template with held writes and tight scopes, and say clearly that children’s records require a named human approver. Do not promise “works with your ChMS” in adoption guides until at least one template is approved and documented.

---

#### GAP-P6 — No inbound email or SMS mailbox

**Wanted:** volunteers email or text a staff agent; parents get a pickup reminder by SMS; a person approves a held message by replying in their inbox.

**Why it fails today:** the only chat ingress is Discord (`packages/gatekeeper/src/ingress/discord.ts`; `SPEC.md` defers Slack). There is no SMS/Twilio (or similar) system or ingress. Gmail exists as an *egress* HTTP system (`google-gmail` in `systems_import`), not as “email the agent and it wakes.” Approval adapters list email, Slack, Teams, and links as **Not built** (`docs/APPROVAL_ADAPTERS.md`). A secretary who does not use the console or Discord cannot complete a hold.

**Suggested fix:** (1) an inbound email webhook or Gmail-push wake that creates a run from a message to a designated address; (2) an SMS ingress/egress vendor as an approved system with holds; (3) an email (or signed, authenticated link) approval adapter as already sketched in `docs/APPROVAL_ADAPTERS.md`. For preschool and SIP, (1) and (2) are more important than Discord polish.

---

### Major

#### GAP-P7 — Slack is not a mailbox (and is not even a seeded API)

**Wanted:** the office already uses Slack; they want the agent there, and they want to approve work there.

**Why it fails today:** `SPEC.md` says Slack RTM / socket transfer remain deferred. Ingress is Discord + HTTP only. `docs/APPROVAL_ADAPTERS.md` marks Slack “Not built.” The catalog has unapproved static-token instructions (`packages/keymaster/src/catalog.ts`, id `slack`) but `systems_import` does not seed a Slack HTTP system, so even “post with a bot token” needs a custom system proposal.

**Suggested fix:** seed a Slack HTTP system and catalog-approve the token instructions for egress; treat Slack ingress and Slack approvals as a larger gatekeeper-ingress project. Do not advertise Slack as supported until ingress exists.

---

#### GAP-P8 — Google Sheets (and Excel) are not first-class systems

**Wanted:** a SIP chapter’s bed, child, and delivery roster lives in a spreadsheet; the church volunteer list often does too. An agent should read and update rows, with holds on writes.

**Why it fails today:** `google-drive` and `google-drive-upload` are seeded; a Sheets API system is not (`landing-zones/aws/variables.tf` `systems_import`). There is no Excel / Graph spreadsheet system (see GAP-P4). Drive can store a file; it is not a cell-level API.

**Suggested fix:** approve a `google-sheets` HTTP system with `connection: "google"` and upstream `https://sheets.googleapis.com`, plus catalog notes and a default hold on write methods. This is a small, high-leverage addition relative to a new vendor integration.

---

#### GAP-P9 — Platform OAuth apps cannot be created by a non-technical admin

**Wanted:** “Connect Google” means one button, like a consumer app.

**Why it fails today:** user consent **works today** in the Credentials view (`GET /api/v1/connections/:agentId/:provider/start`, `packages/control-plane/src/connections.ts`; `CredentialsView.tsx`). But each factory needs a one-time Google (and LinkedIn/X) OAuth *client*, created in the Google Cloud / developer console, with redirect URL `<factory>/api/v1/connections/google/callback`, then pasted write-only (`packages/keymaster/src/catalog.ts`, `google-oauth-client`). Unverified Google apps require test users. Discord and GitHub have guided app-setup (`/api/v1/keymaster/agents/:agentId/app-setup`); Google Workspace does not.

**Suggested fix:** for hosted factories, the operator should own one verified Google app (or a small pool) and inject the client. Longer term, a hosted multi-tenant app with per-org consent, so adopters never see Google Cloud. Document the unverified-app / test-user failure in the adopter guide so it is not mistaken for a factory outage.

---

#### GAP-P10 — Factory-wide budgets alert but do not stop spending

**Wanted:** “Never spend more than $X this month on this church, including AWS.”

**Why it fails today:** per-agent `budgetUsd` **does** refuse model calls and wakes with 402 (`packages/budget/src/standing.ts`, `packages/budget/README.md`). Factory budgets (`PUT /api/v1/spend/budgets`, fields `aiMonthUsd` / `infraMonthUsd` / `totalMonthUsd`) only emit `budget.alert` ledger rows (`packages/control-plane/src/spend.ts`, `checkFactoryBudgets`). Credits are excluded from budget judgment (`packages/budget/src/cloud.ts`). Agent Fargate time is report-only and not in `budgetUsd`. Always-on ALB, VPC endpoints, and house tasks keep billing even if every agent is stopped.

**Suggested fix:** define an explicit “hard cap” mode that refuses new wakes and optionally scales house services only after a documented break-glass path; document today’s alert-only behavior in every adopter-facing cost page. Pair with an AWS billing alarm in the landing zone by default.

---

#### GAP-P11 — Reference AWS landing zone has a high fixed cost for a small nonprofit

**Wanted:** a quiet pilot that costs “a few dollars of AI” plus a little hosting.

**Why it fails today:** always-on control plane, egress, ingress, optional console, ALB, EFS, and **four interface VPC endpoints in two AZs** (`landing-zones/aws/README.md`). Using in-repo Fargate rates (`FARGATE_US_EAST_1`, `packages/budget/src/cloud.ts`) the house tasks alone are on the order of $45–63/month; endpoints and ALB commonly push a quiet factory into a **~$140–220/month** band (`costs-and-billing.md`). Agent token caps cannot reduce that floor. AWS promotional credit can defer it, but TechSoup eligibility may exclude some churches (§ below and `costs-and-billing.md` §5).

**Suggested fix:** a documented “small org” landing-zone profile (fewer endpoints or a different isolation tradeoff, optional ingress when Discord is unused, right-sized tasks) and/or a hosted price that absorbs the floor. Be honest in pre-sales: do not compare only model rates to ChatGPT Plus.

---

#### GAP-P12 — Approvals do not meet people where they work

**Wanted:** approve a draft newsletter or a volunteer text from email or Slack, on a phone, without a factory account mental model.

**Why it fails today:** only the console and Discord DM replies are built (`docs/APPROVAL_ADAPTERS.md`). Console Approve/Reject buttons are shown for the global approver or admin role; owners without those roles are steered to Discord or the API. Chat history for “where to ask” is in-memory for an hour. MCP-originated approvals are not asked in a channel.

**Suggested fix:** implement the email/link adapter already specified in that document, and/or Slack once ingress exists. For a church and SIP chapter, email approval is the high-value path. Until then, a hosted operator must put the right staff in the console (and not assume Discord).

---

#### GAP-P13 — No in-product support or adopter operations path

**Wanted:** “The dashboard is down on Saturday before a delivery; who do we call?” Also: password-less staff changes, a simple status page, and guides that do not reference Terraform.

**Why it fails today:** the repo is an engineering tree (`AGENTS.md`, `docs/CLI.md`, cartridge guides). There is no support mailbox adapter, no status page for customers, and no in-console “invite a staff member with an email and a simple role picker” story that is documented for a non-technical admin (principal/grants APIs exist for operators: `packages/control-plane/src/grants-routes.ts`).

**Suggested fix:** a hosted support commitment (email/phone), an invite-by-email flow in the Identities UI written for office managers, and adopter guides (this draft set is a start) shipped in the repo’s `docs/` only after product review.

---

#### GAP-P14 — Nonprofit credits are external and easy to get wrong

**Wanted:** “We’re a church / a SIP chapter; the cloud should be free or cheap.”

**Why it fails today:** nothing in the factory applies Google, Microsoft, or AWS nonprofit programs. AWS credit is up to $5,000 via TechSoup ([AWS program](https://aws.amazon.com/government-education/nonprofits/nonprofit-credit-program/)). TechSoup US is aimed at 501(c)(3) public charities and states that religious organizations *as such* are not eligible ([TechSoup join article](https://support.techsoup.org/hc/en-us/articles/360055217213-How-to-Join-TechSoup-U-S)). Google excludes fiscally sponsored orgs ([Google for Nonprofits FAQ](https://www.google.com/nonprofits/resources/faq/)). Factory budgets ignore credits (`cloud.ts`), so FinOps can disagree with the cash bill.

**Suggested fix:** an adoption checklist for legal structure (own 501(c)(3), group exemption, fiscal sponsor, school-like preschool) before promising credits. In FinOps, show gross, credit, and net side by side (the Accountant already computes them) in language a treasurer trusts.

---

### Minor

#### GAP-P15 — Keymaster instruction catalog is entirely unapproved

**Wanted:** in-product how-to text a pastor can follow without wondering if it is a draft.

**Why it fails today:** every `INSTRUCTION_CATALOG` entry has `approved: null` and is labeled “Pending human review” (`packages/keymaster/src/catalog.ts`). The submit/consent flow still works.

**Suggested fix:** a person reviews and sets `approved: { by, at }` in a PR, as the file already describes.

---

#### GAP-P16 — Catalog copy quality (example: Discord intents wording)

**Wanted:** instructions that use the vendor’s own words.

**Why it fails today:** the Discord entry tells the reader to open “Privileged GatekeeperEgress Intents” (`packages/keymaster/src/catalog.ts`). That is factory jargon leaking into a Discord tutorial (Discord’s label is Privileged Gateway Intents).

**Suggested fix:** fix copy during the catalog approval pass (GAP-P15).

---

#### GAP-P17 — Azure landing zone is not an implementation

**Wanted:** “We already have Microsoft 365 and would rather stay on Azure.”

**Why it fails today:** `landing-zones/azure/README.md` is a bind table, not Terraform. Even if it were complete, Microsoft *connectors* would still be missing (GAP-P4).

**Suggested fix:** only promise Azure after a real landing zone *and* Graph connectors exist. Until then, hosted AWS (or Compose) plus Google, or wait.

---

#### GAP-P18 — Ingress and Motion/GitHub/Health seeds add noise for these orgs

**Wanted:** a factory that does not ask a church about GitHub tokens or Google Health scopes.

**Why it fails today:** `systems_import` and always-on gatekeeper-ingress come from the BeerCanLabs reference shape (`variables.tf`, `ecs.tf`). They are harmless if unused (ingress still costs a small always-on task) but clutter Credentials and cost a bit of Fargate (`~0.25 vCPU` ingress in `ecs.tf`).

**Suggested fix:** a “community org” import set (Google + later Sheets/Slack, no Health, optional GitHub) and a way to scale ingress to zero when no Discord surface is configured.

---

#### GAP-P19 — Groups can be mistaken for organizations

**Wanted:** “We’ll make a Preschool group and a Missions group.”

**Why it fails today:** groups are RBAC (`group-routes.ts`). They do not isolate secrets, billing, or ledgers (GAP-P2). Using them as if they were departments with separate data would over-promise.

**Suggested fix:** name them “access groups” in the UI and docs; reserve “organization” for a future tenant object.

---

### Suggested priority if the factory team does a short hosted-pilot cut

1. Hosted dedicated-factory playbook (GAP-P1, P3, P2 as a policy: no colocation) and honest cost sheet (P11, P10, P14).
2. Operator-owned Google OAuth app + Sheets system + held Gmail sends (P9, P8, part of P6).
3. Email approval adapter (P12) so Discord is not required.
4. Then Microsoft Graph (P4) or Planning Center (P5) or SMS (P6), chosen by the first real customer’s actual tools — not all three at once.

Until (1) exists, neither example organization can adopt the factory without becoming a Terraform shop, which they will not.


### Review: Security, privacy and child safety (`GAPS-security.md`)
Format: ID · Severity · What the adopter is trying to do · Why it fails today (evidence) · Suggested fix

Severity:

- **Blocker** — a church preschool or an SHP chapter cannot adopt this use safely, or would be blocked from a duty they must meet (consent, deletion, licensed-record handling, human approval of family messages).
- **Major** — adoption is possible for a narrow, adult-only, no-sensitive-data pilot, but a real rollout is difficult or risky.
- **Minor** — confusing, incomplete, or easy to get wrong; not by itself a reason to stop a carefully scoped pilot.

Overlaps with `GAPS-core.md` are noted. Claims are grounded in the current factory code (control plane, bouncer, gatekeeper, runtime, console).

---

### Blocker

#### SEC-1 · Blocker · No parental consent, review, or deletion for children’s data
- **Trying to:** Let a preschool or an SHP-adjacent child-facing helper collect or keep anything a child (or a teacher saying a child’s name, allergy, or address) types, in a way that can meet COPPA-style duties: notice, verifiable parental consent, parent review, and deletion (16 C.F.R. Part 312).
- **Why it fails:** There is no consent object, parent portal, or per-person delete/export API on principals or conversations. `POST /api/v1/principals/:id/revoke-access` removes *access* and leaves the person record (`packages/control-plane/src/grants-routes.ts`). Conversation requests only `list` or `turns` (`POST /api/v1/agents/:id/conversation-requests` in `packages/control-plane/src/app.ts`). Cartridge `retentionDays` is not enforced by the factory (GAP-116, `docs/architecture/agent-memory-models.md`). Related: CORE-13.
- **Fix:** A child-data mode with parental consent on file, a parent-facing review/export/delete, factory-enforced retention, and a documented residual (ledger WORM rows). Until then, official guidance should remain: do not let children use agents and do not put child records in chats.

#### SEC-2 · Blocker · Children’s and family content is sent to third-party AI providers with no child-data path
- **Trying to:** Ask an office assistant about a classroom without a vendor seeing allergies, custody limits, or SHP delivery addresses; or use a model with zero retention / a contractual child-data restriction.
- **Why it fails:** Egress is deny-by-default until a policy allows a model route (`packages/control-plane/src/app.ts` E7; SPEC). Once a model route is allowed, the prompt (current turn plus whatever memory the cartridge loads) goes to the configured vendor (OpenAI / Anthropic / Gemini / subscription connections; `packages/control-plane/src/ai-providers.ts`, gatekeeper egress). There is no “child or licensed-record” flag, no automatic redaction, and no preschool preset that forces an on-prem or zero-retention model.
- **Fix:** Data-classification on turns and memories; a forced vendor allowlist and DPA packet for child or address data; optional redaction; a default “sensitive agent” that cannot call external models. Until then, policy is “do not put that data in the factory.”

#### SEC-3 · Blocker · “Kid-safe mode” does not filter what a model says or what a child may type
- **Trying to:** Offer a kid-safe helper that stays age-appropriate and will not do adult errands.
- **Why it fails:** Child *routing* is real: a `relationship: "child"` member must have a non-empty `targetAgents` list; other agents and `mode: "errand"` / agent-to-agent tools return `403 child_restricted` (`packages/bouncer/src/speak-as.ts`, `packages/control-plane/src/speak-as-converse.ts`, `runtimes/agent-runtime/runtime/skills.py`). But “use a kid-safe tone” is documentation only (`docs/SPEAK_AS.md`). `format_verified_caller` in `runtimes/agent-runtime/runtime/loop.py` lists `relationship=child` and general caller guidance; it does not inject a safety policy or blocked-topic list. Relationship is optional; a minor enrolled without `child` gets none of the restrictions.
- **Fix:** Make `child` mandatory when the principal is under 13 (or under 18, by policy); inject an enforceable safety profile; add a model-side or factory-side content filter; refuse enrollment of minors until consent (SEC-1) exists.

#### SEC-4 · Blocker · Speak-as trusts the client’s assertion of who is speaking
- **Trying to:** Put a voice client in a hallway or classroom and have the factory know it is a teacher, not a child, or a named child with a parent present.
- **Why it fails:** “Speaker identification (voice ID, a spoken name, or a PIN) happens on the robot / Rosie. The factory accepts an asserted enrolled user id or alias; it does not perform biometrics.” `assurance` is metadata, not a second authorization check (`docs/SPEAK_AS.md`). A compromised or mis-set client can speak as any enrolled member on that grant, including an adult owner.
- **Fix:** Factory-verified factors (PIN checked by the control plane, presence of a parent session, short-lived speaker tokens). Do not deploy voice clients around children on assertion-only grants.

#### SEC-5 · Blocker · Outbound messages to families are not held unless someone configures them, and email approval is not built
- **Trying to:** Let an agent draft an enrollment or delivery message and require a director to approve the exact text from email or the dashboard they already use.
- **Why it fails:** Holds apply only when a route has `hold` or a skill action declares `hold: true` (no default; `packages/contract/src/skill.ts`, `packages/gatekeeper/src/egress/gatekeeper-egress.ts` E9). An allowed Discord/HTTP/email route without a hold is sent. Approval adapters are console and Discord DMs only; Slack, Teams, email, and links are “Not built” (`docs/APPROVAL_ADAPTERS.md`). Console Approve/Reject buttons are only for global approver/admin, not for an agent owner. Some decision holds still expect GitHub logins (CORE-4).
- **Fix:** A factory-wide policy: “any egress that contacts a person is held.” Name approvers as factory principals / email. Ship an email (or SMS) adapter that shows the full outbound copy. Until then, do not allow family-facing routes, or have the factory team pre-configure holds and staff a console-approval rota.

---

### Major

#### SEC-6 · Major · No special protection for preschool records, SHP addresses, donor files, or background-check packets
- **Trying to:** Store or let an agent look up “who may pick up this child,” an allergy, a delivery address, a donor amount, or a volunteer clearance, with access limited to the preschool director or chapter president.
- **Why it fails:** The factory has no record types or ACLs for those classes of data. Anyone who can talk to the agent, plus any admin using `conversations.read-others` (`packages/bouncer/src/privileges.ts`, `app.ts` AM5), can see what was said. Viewer+ can read ledger metadata. Background-check confidentiality (e.g. Arizona notarized forms) has no vault.
- **Fix:** Classified stores with purpose limitation, field-level access, and a two-person rule for admin reads of child or clearance data. Until then, keep those records out of the factory.

#### SEC-7 · Major · Admin can read any conversation, including a child’s, with only a ledger row
- **Trying to:** Let a preschool director review *their program’s* agent, without every factory admin being able to open a family’s chat.
- **Why it fails:** `conversations.read-others` is an admin-only privilege and is ledgered (subject actor, not content) (`packages/control-plane/src/app.ts` around the `/conversation-requests` route). There is no scoped “records official,” no two-person rule, and no child-data banner.
- **Fix:** Scope conversation reads to agent owners or a compliance role; require a reason; dual control for child conversations; notify the parent or the board officer on the policy.

#### SEC-8 · Major · Factory does not enforce memory retention or per-person erasure
- **Trying to:** Honor a “delete our family’s data” request, or keep preschool-related memories only as long as state licensing requires (and not in WORM logs forever).
- **Why it fails:** Same evidence as SEC-1 / CORE-13 / GAP-116. Agent purge is whole-agent, two-stage (`RETIRED_PENDING_PURGE`). Ledger checkpoints can be S3 Object Lock compliance mode (`packages/ledger/src/checkpoints.ts`), so people and grant snapshots (including emails) cannot be erased on request during the retention window.
- **Fix:** Per-person memory export/delete; factory-enforced retention; minimize PII in ledger snapshots; a written residual-data notice for WORM rows.

#### SEC-9 · Major · Speak-as administration has no console UI
- **Trying to:** A church admin enrolls, allowlists, expires, and revokes household or staff speakers without a CLI.
- **Why it fails:** Grant APIs and `factory speak-as` exist (`docs/SPEAK_AS.md`, `packages/control-plane/src/speak-as-routes.ts`). `packages/console/src` has no speak-as view. Offboarding in People & Access does not unenroll speak-as members.
- **Fix:** A People & Access panel: members, aliases, relationship, target agents, expiry, revoke. Include speak-as unenroll in revoke-all-access (with a confirm checkbox).

#### SEC-10 · Major · Offboarding leaves long-lived API keys, and the Keys screen cannot issue scoped keys for someone else
- **Trying to:** On a volunteer’s last day, turn off everything they could use; issue a narrow key for a front-desk tablet or another staff member from the dashboard.
- **Why it fails:** `revokeAllAccess` explicitly does **not** revoke long-lived `fk_` keys (`packages/control-plane/src/grants-routes.ts` #436). A leftover `domain:` grant can still empower that key. Your API Keys calls `issueKey(deviceFamily)` with no owner, no scopes, no agent picker (`packages/console/src/views/KeysView.tsx`, `packages/console/src/api/client.ts`). Issuing for another owner requires a signed-in admin `POST /api/v1/keys` (API keys themselves get 403). Related: CORE-8, CORE-9.
- **Fix:** Default “also revoke keys” on offboarding; show keys on the person row; admin Keys UI with owner, scopes, agent allowlist, and expiry.

#### SEC-11 · Major · Household relationships are the only kid/adult model
- **Trying to:** Express “teacher,” “parent of this child,” “Sunday volunteer,” or “SHP delivery captain” so tools and memory follow organizational authority.
- **Why it fails:** Speak-as relationships are only `owner` | `family` | `child` (`packages/bouncer/src/speak-as.ts`). Fleet roles are viewer / operator / approver / admin / budget-owner (`packages/bouncer/src/grants.ts`). There is no parent-of, no classroom scope, no volunteer role (CORE-11).
- **Fix:** Organizational relationship types and scoped grants that match church and chapter offices; keep `child` as a hard safety class.

#### SEC-12 · Major · No product incident-response or breach-notification workflow
- **Trying to:** After a roster or address is pasted into chat, follow a script: contain, see what left, notify the right people, file a board report.
- **Why it fails:** Isolate / pause / fleet state / key revoke **work today**, but there is no wizard, no per-person data inventory, no “what the vendor received” report, and no parent-notification helper. Triage & Incidents in the console is an operator tool, not a breach playbook (CORE-15 is the support-path cousin).
- **Fix:** An incident flow that pulls ledger rows, lists agents and vendors involved, and exports a timeline. Keep a written policy (see `governance.md`) in the meantime.

#### SEC-13 · Major · No subprocessor / DPA packet for a board
- **Trying to:** Show elders or an SHP national reviewer where data and model calls go, in writing, before go-live.
- **Why it fails:** Architecture docs describe egress and vendors, but the product does not generate an organization-specific subprocessor list, data map, or data-processing agreement. Cloud region and WORM bucket are deploy-time (**needs the factory team**).
- **Fix:** An auto-generated data map from live policy, connections, and model catalog, plus a standard DPA the factory team can sign.

#### SEC-14 · Major · No control that stops card numbers or other secrets being typed into chat
- **Trying to:** Take donations safely and prevent a well-meaning volunteer from putting a card number or a Social Security number in an agent.
- **Why it fails:** The factory is not a payment processor and has no PAN/SSN filter on turns or memories. PCI DSS still matters if cardholder data is stored or transmitted ([PCI SSC](https://www.pcisecuritystandards.org/standards/pci-dss/)).
- **Fix:** Input scanning that refuses or redacts PANs and similar identifiers, plus a documented “giving stays on the giving platform” pattern.

#### SEC-15 · Major · whoami mislabels how a key authenticated
- **Trying to:** Audit whether a connector is using an API key or Cloudflare Access.
- **Why it fails:** `GET /api/v1/whoami` sets `signedInWith` from “has `Authorization`? then `api-key`, else session IdP, else `cloudflare-access`” and does not consult `requestApiKey` (`packages/control-plane/src/grants-routes.ts`). Observed: `fk_` Bearer calls labeled `cloudflare-access`. Same issue as CORE-14, called out here because it undermines security review.
- **Fix:** Label from `identify()`’s actual path: `api-key` (with key id prefix), `session:<idp>`, or `cloudflare-access`.

---

### Minor

#### SEC-16 · Minor · Viewer and operator are too powerful as “volunteer” stand-ins
- **Trying to:** Give a Sunday volunteer a safe, read-mostly login.
- **Why it fails:** `viewer` includes ledger, spend, connections, `content.submit`, and `subscriptions.own`. `operator` can converse, create agents, and reset them (`packages/bouncer/src/privileges.ts`). There is no volunteer role (CORE-11).
- **Fix:** A volunteer/staff preset with almost no fleet visibility and access to one agent only.

#### SEC-17 · Minor · Domain-wide grants survive a person’s offboarding story
- **Trying to:** Remove one staff member and be sure their email-domain grant cannot come back through a leftover key or a later hire reused address.
- **Why it fails:** Revoke-all is per principal. `domain:example.org` grants remain (`packages/bouncer/src/grants.ts`, People & Access). CORE-9 already notes the key interaction.
- **Fix:** Warn on offboarding if a domain grant still covers that email; prefer named-person grants in the product default.

#### SEC-18 · Minor · Assurance and via are easy to misuse in tools
- **Trying to:** An agent tool treats “voice-asserted” or “via: Rosie” as proof of the owner.
- **Why it fails:** Docs require tools to use stamped `actor`, `isOwner`, and `agentRoles`, never `via` (`docs/SPEAK_AS.md`, `deliveredCaller` in `packages/bouncer/src/speak-as.ts`). Nothing systematically blocks a skill from ignoring that.
- **Fix:** Runtime guards so tools cannot take authority from `via` or `assurance`; skill review checks.

#### SEC-19 · Minor · No expiry reminders for keys or speak-as grants
- **Trying to:** Hear about a grant or key that will expire, or one that never expires and should be rotated.
- **Why it fails:** Keys and speak-as grants support `expiresAt`, but there is no reminder, digest, or console badge for “unexpiring child-adjacent grant” or stale keys (`lastUsedAt` is displayed only on Your API Keys for *your* keys).
- **Fix:** Admin digest and a required max lifetime for keys and speak-as grants.

#### SEC-20 · Minor · Console session and MFA depend entirely on the IdP and deploy
- **Trying to:** Require MFA and stay signed in across a factory restart.
- **Why it fails:** Factory login can use Google / Cloudflare / OIDC (`packages/control-plane/src/login.ts`). MFA is whatever that provider enforces (**needs the factory team**). Sessions are in memory; a restart signs everyone out (CORE-10).
- **Fix:** Document a required-MFA IdP baseline; persist sessions (CORE-10).

#### SEC-21 · Minor · Ledger is readable by every viewer, and may contain emails in snapshots
- **Trying to:** Restrict audit-log access to a compliance officer; avoid writing unnecessary personal data into a WORM store.
- **Why it fails:** `ledger.read` is on viewer (`packages/bouncer/src/privileges.ts`). Grant/principal mutations store `before`/`after` snapshots (`packages/ledger/src/sanitize.ts`, `grants-routes.ts`).
- **Fix:** A narrower audit role; snapshot minimization (ids, not full email lists, where possible).

---

### Suggested priority for the factory team

1. Child-data ban remains the official adopter guidance until SEC-1, SEC-2, SEC-3, and SEC-4 are closed.
2. Default-hold all person-contacting egress, and ship an email approval adapter (SEC-5).
3. Offboarding that revokes keys and speak-as, plus a console for both (SEC-9, SEC-10).
4. Per-person export/delete and a board-ready data map (SEC-8, SEC-13).
5. Fix whoami labeling (SEC-15) — small, but it blocks trustworthy audits.


### Review: Church + preschool (`GAPS-church.md`)
Companion to `church-preschool-playbook.md`. Each gap is written for a mid-sized church (~400 people) with a licensed preschool (100+ children) and **no IT staff**.

Severity:

- **Blocker** — adoption of the intended use is stopped, or doing it anyway would be unsafe (child data, custody, money, counseling).
- **Major** — a church can start a narrow pilot (Google drafts in the dashboard) but will stall, misuse the tool, or refuse to expand until this is fixed.
- **Minor** — friction, confusion, or a sharp edge that should be fixed but does not stop the pilot.

Format for each item: what they are trying to do, why it fails today (with a file or endpoint), and a suggested fix. Overlaps with `GAPS-core.md` are kept here when the church or preschool harm is specific.

---

### Blocker

#### CHURCH-1 · Blocker · No dedicated, no-IT factory for the church

- **Trying to do:** "Sign our church up and give Maria, the church administrator, a dashboard."
- **Why it fails today:** There is no organization or tenant in the control plane. Principals, grants, agents, spend, connections, and the ledger are factory-global. The running dashboard at factory-dashboard.dalesackrider.com is one organization's factory. Putting Grace Church on it would let that factory's administrators see the church's agents, spend, and ledger. The other official path is to deploy a landing zone (`landing-zones/PATTERNS.md`, `landing-zones/aws`, `landing-zones/gcp`): cloud accounts, DNS, identity, ingress CIDRs that may not be `0.0.0.0/0` (`landing-zones/aws/variables.tf`). A church with no IT staff cannot do that.
- **Suggested fix:** A factory-team-hosted "one factory per church" offering (or real multi-tenant isolation with `orgId` on principals, grants, agents, spend, ledger, and connections). The first login the church sees should be "Sign in with Google / Microsoft" at *their* URL.

#### CHURCH-2 · Blocker · No church or preschool connectors on the shelf

- **Trying to do:** Connect the systems they already run: Planning Center, Breeze, Realm, Tithe.ly, Pushpay, Brightwheel, Procare, Remind, Mailchimp, Canva, QuickBooks, Microsoft 365.
- **Why it fails today:** The Keymaster instruction catalog only has Discord, GitHub, Slack, Notion, xAI, Anthropic, Home Assistant, Google, LinkedIn, and X (`packages/keymaster/src/catalog.ts`, ids starting at the `discord` entry). None of the church or preschool products appear. The default skill list is empty (`packages/control-plane/data/skill-defaults.json`, `"skills": []`). Staff agents shipped with the repo are factory-manager, agent-builder, and personal-trainer (`agents/staff`), not a volunteer scheduler or preschool clerk. A generic HTTP or OAuth "system" *can* be proposed and approved (`packages/contract/src/system.ts`, `/api/v1/systems`, `packages/keymaster/src/connections.ts` `GET /api/v1/connections/:agentId/:provider/start`), but writing that definition is an implementer's job. The church cannot click Connect on Planning Center.
- **Suggested fix:** A reviewed catalog of church and preschool systems (start with Google Workspace, Microsoft 365, Planning Center, QuickBooks Online read-only, Mailchimp) plus installable skills and agent templates. Brightwheel/Procare should be scoped in writing *before* any skill exists, and should default to off.

#### CHURCH-3 · Blocker · Staff cannot talk or approve in the channels they already use

- **Trying to do:** The preschool director, from the classroom doorway or from home, approves a parent announcement on her phone. The volunteer coordinator receives a draft ask by email or text and says yes. An elder who does not have Discord and is not sitting in the dashboard still participates.
- **Why it fails today:** People can talk to an agent in the dashboard workbench (`packages/console/src/views/AgentWorkbench.tsx`, `POST /api/v1/agents/:id/conversation`) or via Discord. Cartridge triggers are only cron, webhook, queue, http, and Discord (`packages/contract/src/schema.ts`, `triggerSchema`). Approval adapters are Console, Discord, and the API; "Slack, Teams, web chat, email, a link" are explicitly **Not built** (`docs/APPROVAL_ADAPTERS.md`). A Slack *token* can be stored, but Slack is not an ingress or an approval channel. Without phone-friendly approval, directors will either skip agents or be tempted to pre-approve, which defeats the hold.
- **Suggested fix:** Email and SMS (or a single-use link) as talk *and* approval channels, showing the full outgoing message, with the adapter — not the agent — recording the person's decision. Then Microsoft Teams / Slack. Do not make Discord the church's front door.

#### CHURCH-4 · Blocker · No product controls to keep preschool records out of the factory

- **Trying to do:** Use a virtual office clerk without creating a second, unofficial copy of attendance, ratios, pickup authorizations, custody orders, incident reports, or allergy and medication data. Survive a licensing visit. Honor a parent's request to see or delete their child's information.
- **Why it fails today:** Memory is a notebook plus closed volumes in object storage (`docs/architecture/agent-memory-models.md`). Anything a teacher pastes or an over-broad connection reads becomes a lasting copy. There is no data classification ("child," "medical," "custody"), no field-level blocklist, no preschool retention policy, and no "delete this family's data" API or dashboard flow. Ledger checkpoint retention is a deploy setting, not a per-child control. Official vendors (Brightwheel, Procare) are not connected, which is safer *until* someone pastes a roster into the workbench — and the product does not stop them. Agents can also be given tools that write, if policy allows it; deny-by-default helps only if the factory team configured policy correctly (`packages/gatekeeper/src/policy/index.ts`, empty `routes` by default).
- **Suggested fix:** A preschool profile that (1) refuses or redacts defined categories in chat and in connectors, (2) blocks those connectors until a written agreement is marked complete, (3) offers export and deletion of a child's or parent's traces and notebook entries, and (4) logs access. Until then, the playbook's rule ("agents never the system of record; never paste this data") is policy only, not enforcement. Treat live preschool-record connections as unsafe to ship.

#### CHURCH-5 · Blocker · The dashboard cannot create the virtual staff

- **Trying to do:** After training, Maria adds "Facilities and Events" herself, the way she would add a mailbox.
- **Why it fails today:** Creation is `POST /api/v1/agents` (`packages/control-plane/src/agent-creation.ts`, privilege `agents.create`) or the headless Agent Builder cartridge, which is driven by text commands like `set id` and `publish` (`agents/staff/agent-builder/README.md`) and is not in the baked catalog. The console API client has no create-agent call (`packages/console/src/api/client.ts`). Cartridge Studio is a developer registration screen, not a job-description wizard. New agents sit in `PENDING_BUDGET` until policy and budget are set (`docs/CREATING_AGENTS.md`). A church administrator cannot do this without the factory team.
- **Suggested fix:** A dashboard "New agent" wizard on top of configuration-only agents, with the playbook's templates (Office Front Desk, Communications Drafter, and so on), a people picker, Google Connect, and required write-holds and budget caps as defaults.

---

### Major

#### CHURCH-6 · Major · Microsoft 365 is not a first-class sign-in or tool

- **Trying to do:** A church that already pays for Microsoft 365 signs in with work Outlook accounts and lets the Office agent draft in Outlook / Calendar / OneDrive / Teams.
- **Why it fails today:** Built-in identity providers are `google`, `meta`, `cloudflare`, and generic `oidc` (`IDP_KINDS` in `packages/control-plane/src/idp-config.ts`, `/login`, `/api/v1/auth/:idp/start`). There is no Microsoft catalog entry and no Graph system. Generic OIDC could cover Entra, and a system definition could cover Graph, but both are factory-team work. Meta is listed and then refused (`packages/control-plane/src/login.ts` comments that Meta does not confirm `email_verified`). Churches on Microsoft are otherwise stuck until Google is also adopted, which they will resist.
- **Suggested fix:** First-class Entra sign-in and a reviewed Microsoft 365 OAuth system (Calendar, Mail, Files) with the same Connect button as Google, writes held for approval.

#### CHURCH-7 · Major · Pastoral conversations are not sealed from administrators

- **Trying to do:** Give the pastor a private briefing agent (or, someday, a careful care-notes helper) that a church administrator cannot open on a quiet afternoon. Preserve clergy-penitent trust and a clean investigation process when one is actually needed.
- **Why it fails today:** Personal-assistant memory is per person, which is the right shape (`docs/architecture/agent-memory-models.md`, AM2–AM5). But `conversations.read-others` is an **admin** privilege (`packages/bouncer/src/privileges.ts`). The dashboard can ask an agent for another person's conversations; that request is ledgered, but the words live in the agent's notebook and volumes. There is no sealed or clergy-confidential class, no two-person rule, and optional prompt traces could capture pastoral text if someone turns them on. The person who resets everyone's access is often the same administrator.
- **Suggested fix:** A confidential memory class that ordinary factory admins cannot read; a two-person, ledgered break-glass with a reason; prompt traces off and locked for that class; a playbook default that counseling notes stay out of agents until this exists. Do not sell a "counseling agent" before the seal exists.

#### CHURCH-8 · Major · No parent-safe door (and parents must not get factory accounts)

- **Trying to do:** Answer "what time is preschool pickup" or "is there a snow day" without putting families on the staff dashboard, and without building a shadow student information system.
- **Why it fails today:** Sign-in is for factory principals. Grants can be scoped to an agent (`GrantScope` in `packages/bouncer/src/grants.ts`), but there is still no "only my children" boundary, no guardian verification, and no public Q&A surface that is limited to a published FAQ. A website widget, SMS short code, or parent portal is **not built** (see CHURCH-3). Giving parents viewer or member accounts would over-share.
- **Suggested fix:** If parent self-service is ever desired, a separate, FAQ-only surface with no notebook, no staff tools, and no child records — not a factory login. Until then, keep the playbook rule: parents call the office or use Brightwheel/Procare.

#### CHURCH-9 · Major · People and roles are not church-shaped

- **Trying to do:** Add "Alicia, preschool director" and "front-desk Sunday volunteers for the next 90 days" with obvious rights. Let every `@church.org` staff mailbox sign in as a viewer without a ticket.
- **Why it fails today:** Fleet roles are viewer, operator, approver, admin, and budget-owner (`FLEET_HUMAN_ROLES` in `packages/bouncer/src/grants.ts`). Operator can create agents and converse; viewer cannot converse (`packages/bouncer/src/privileges.ts`). The right model — member of one agent — exists, but it is grant machinery, not a "preschool director" preset. A first Google sign-in has empty roles (`packages/control-plane/src/login.ts`). Domain grants exist (`DOMAIN_SUBJECT` in `packages/bouncer/src/grants.ts`) but are easy to get wrong (a domain grant plus a leftover key is called out in core gaps). There is no invite email, no expiry UI aimed at seasonal volunteers, and the dashboard language is still factory jargon.
- **Suggested fix:** Job presets from the playbook (director, treasurer/budget-owner, teacher draft-only, front-desk member, elder viewer, pastor-owner). Invite by email. Time-boxed volunteer membership. A simple-mode dashboard that hides Studio, Systems, and Triage from those roles.

#### CHURCH-10 · Major · Schedules are easy to get wrong, and hard to see

- **Trying to do:** "Every Friday at 10:00 America/Phoenix, draft the Sunday announcements and wait for Maria's approval." "Remind the director tomorrow at 3, once." See what is scheduled without asking the agent. Be told if a job did not run because the agent was over budget or paused.
- **Why it fails today:** Recurring schedules exist (`POST /api/v1/schedules`, `packages/control-plane/src/schedules.ts`). If no time zone is sent, the default is `America/Los_Angeles` (`DEFAULT_TIMEZONE` in `packages/timekeeper/src/cron.ts`). Arizona churches, and anyone else not on Pacific time, will get the wrong local hour, worse across daylight saving. One-shot reminders, a next-run answer, in-place edit/pause, a dashboard schedules screen, and a notice when a due job cannot start are documented as gaps (`docs/timekeeper-roadmap.md`). The `factory-schedules` skill is discussed there and is not a default skill (the default list is empty).
- **Suggested fix:** Require an explicit time zone (factory default set at hosting time to the church's zone), one-shot timers, a Schedules view, and a message to the named owner when a run is skipped.

#### CHURCH-11 · Major · Google Connect is real, but not turnkey for a church

- **Trying to do:** Maria clicks Connect, signs into the church's Google Workspace, and the Office agent may read the public calendar and draft mail.
- **Why it fails today:** The Google OAuth path exists (`google`, `google-oauth-client` in `packages/keymaster/src/catalog.ts`; start/callback routes in `packages/control-plane/src/connections.ts`). It depends on a platform OAuth client the factory team must install, on Workspace admin consent, and often on Google's "unverified app" test-user list (the catalog instructions already warn about this). Every catalog entry, including Google, is still `approved: null` (pending human review of the instructions). Scopes must be declared correctly or the start route returns `scopes_required`. None of this is a church-office wizard.
- **Suggested fix:** Factory team completes Google app verification, approves the catalog copy, and ships a Connect checklist for Workspace admins (which organizational unit, which calendars, mail send held). Same later for Microsoft.

#### CHURCH-12 · Major · Money and giving connections are missing, and writes would be too dangerous anyway

- **Trying to do:** The treasurer asks, "Are we on pace with the budget?" from QuickBooks or Tithe.ly/Pushpay, and never lets an agent change the books or email a giving statement unattended.
- **Why it fails today:** Those vendors are absent from the catalog and default skills (see CHURCH-2). Even after a connection exists, there is no packaged "read-only treasurer" skill, no donor-data classification, and no statement-send workflow with treasurer holds in a channel the treasurer uses (CHURCH-3). A generic write-capable QuickBooks skill would be a finance incident waiting to happen.
- **Suggested fix:** Read-only QuickBooks Online and giving-platform skills, treasurer-only grants, a board-report template, and a hard policy that statements, refunds, and ledger posts stay human or are held with a full preview.

#### CHURCH-13 · Major · Sessions vanish on restart, and support is not a church office hour

- **Trying to do:** A Sunday volunteer signs in at 8:30 and still has a session at 10:00 after a routine factory update. Someone knows whom to call if the dashboard is down before the first service.
- **Why it fails today:** "A restart signs users out" (`SessionStore` in `packages/control-plane/src/login.ts`). There is no in-product help, status page, or Sunday-safe support path for a non-engineer (the Triage view is for operators). A church will experience this as "it forgot me" or "it's broken on Sunday."
- **Suggested fix:** Persistent sessions, a "keep me signed in on this office computer" option with an idle timeout, and a written support engagement (who to call, what "pause everything" looks like, a status page).

#### CHURCH-14 · Major · No plain-language packet for a board or a licensing specialist

- **Trying to do:** An elder or a state inspector asks, "Show me what the agents can access, what they sent, and where a child's data would or would not be."
- **Why it fails today:** The ledger is append-only and useful (`packages/ledger`), and FinOps shows spend (`packages/console/src/views/FinOpsView.tsx`). There is no one-click, plain-language report: agents, owners, callers, connected systems, held vs. unattended sends, retention, and an attestation that preschool records are not stored. The dashboard labels (fleet, ledger, triage, studio) are not written for that audience.
- **Suggested fix:** A "board / inspector packet" export (PDF or Doc) generated from live grants, systems, policies, and spend, plus the church's written prohibitions. Include a data-map that says what is *not* connected.

---

### Minor

#### CHURCH-15 · Minor · Credential catalog is unfinished and aimed at the wrong audience

- **Trying to do:** Follow in-dashboard instructions to connect a tool, confidently.
- **Why it fails today:** All instruction entries are AI-drafted and `approved: null` (`packages/keymaster/src/catalog.ts` header and each `approved` field). Copy is written for Discord bots, GitHub tokens, and Home Assistant, which will confuse a church office and bury Google.
- **Suggested fix:** Human-review the catalog, hide irrelevant sources from a church-profile factory, and lead with Workspace / Microsoft / Planning Center.

#### CHURCH-16 · Minor · Configuration-change approvals in the dashboard are a poor fit for a board

- **Trying to do:** An elder with the approver role reviews a permission change the way they would review a letter.
- **Why it fails today:** `docs/APPROVAL_ADAPTERS.md` notes that configuration-change items in the console are incomplete ("blind"), and that an approver-only person may see buttons the factory will refuse (owner or admin must decide). Discord shows the change in full — which a church is unlikely to use.
- **Suggested fix:** Full, plain-language change previews in the dashboard, decidable by the named owner, without Discord.

#### CHURCH-17 · Minor · Agent Builder is a command prompt, not a conversation with a secretary

- **Trying to do:** "Help me describe a communications assistant" in ordinary language.
- **Why it fails today:** The Agent Builder speaks structured commands and optional JSON (`agents/staff/agent-builder/README.md`), has no Discord surface, and must itself be admitted like any other cartridge. It does not remove CHURCH-5.
- **Suggested fix:** Fold a natural-language interview into the New Agent wizard; keep the builder as an implementer tool.

#### CHURCH-18 · Minor · LinkedIn and X are in the catalog; church tools are not

- **Trying to do:** Find "the list of apps we can connect."
- **Why it fails today:** LinkedIn and X have OAuth entries and hold-for-post behavior in the catalog (`packages/keymaster/src/catalog.ts`). Planning Center does not. A church scanning the list gets the wrong impression of what the product is for.
- **Suggested fix:** Profile-based catalogs (church, nonprofit, internal engineering).

#### CHURCH-19 · Minor · Groups exist but are not volunteer teams

- **Trying to do:** "Sunday front desk" as a group that can call Office Front Desk in December and is removed in January.
- **Why it fails today:** Group APIs exist (`GET/POST /api/v1/groups`, `packages/control-plane/src/group-routes.ts`, privilege `groups.manage`) but there is no church-facing "volunteer team" UI, expiry, or training flow.
- **Suggested fix:** Expiring groups with a simple membership screen for the administrator.

#### CHURCH-20 · Minor · Default time zone and empty defaults will surprise implementers too

- **Trying to do:** Factory team stands up a Phoenix church quickly without missing a default.
- **Why it fails today:** `DEFAULT_TIMEZONE = 'America/Los_Angeles'` (`packages/timekeeper/src/cron.ts`). Default skills are an empty list (`packages/control-plane/data/skill-defaults.json`). Both are easy to ship "as is" into a church factory.
- **Suggested fix:** Hosting checklist: church time zone, prompt traces off, empty skills confirmed, Google client verified, admin circle named, preschool profile on.

---

### What a church can still do while these gaps are open

A **hosted, dedicated** factory, Google sign-in, three draft-only agents (Office Front Desk, Communications Drafter, Pastor's Briefing), held writes, tight grants, small budget caps, and a written child-data and pastoral-care policy — as in week 1 of the playbook — is possible **if the factory team does the hosting and setup**. Expanding into Planning Center, QuickBooks, parent messaging, preschool records, or counseling notes is not, until the matching gaps above are closed.


### Review: SHP chapter (`GAPS-shp.md`)
Gaps that would make it hard or impossible for a local Sleep in Heavenly Peace chapter (all volunteers, no IT staff) to adopt the Agent Factory and use a virtual staff of agents.

Format: ID · Severity · What the adopter is trying to do · Why it fails today (evidence) · Suggested fix

Core account, sign-in, tenancy, and console gaps are in `GAPS-core.md`. Several of those are also blockers for an SHP chapter (especially CORE-1 no tenant, CORE-2 no self-serve deploy, CORE-3 no console "new agent" button, CORE-4 approvals tied to awkward channels, and CORE-5 no email/SMS/web chat). This file adds what is special to SHP: the official Chapter Portal, family and child privacy, build and delivery operations, Golden Volunteers, DonorPerfect, and national "franchise" rules.

---

### Blocker

#### SHP-1 · Blocker · No connector to the SHP Chapter Portal (Salesforce)

- **Trying to:** Let application managers triage bed requests, update case status, and keep inventory without retyping everything from the official portal.
- **Why it fails:** Bed requests, cases, inventory (beds, mattresses, bedding-in-a-bag, sheets, pillowcases, quilts/comforters), and Golden Events are managed in the SHP Chapter Portal on Salesforce ([Chapter Portal resources](https://shpbeds.org/dashboard/chapter-portal-resources/); [Build resources](https://shpbeds.org/dashboard/build/)). The factory's Keymaster catalog (`packages/keymaster/src/catalog.ts`) has Discord, GitHub, Slack, Notion, Google, LinkedIn, and X — not Salesforce and not shpbeds.org. A new system can be proposed and must be admin-approved (`packages/control-plane/src/systems.ts`, `packages/registrar/src/systems.ts`), but nothing is registered or skilled for this. The default skill list is empty (`packages/control-plane/data/skill-defaults.json`).
- **Fix:** With written national SHP permission, the factory team registers a least-privilege, read-first Salesforce / Chapter Portal system, ships a vetted skill, and keeps the portal as the system of record. Writes (status changes, "scheduled delivery") always hold for a person (E9). Until then, chapters must not build a shadow waitlist.

#### SHP-2 · Blocker · No SMS or phone channel for family follow-up

- **Trying to:** Text a guardian to schedule a delivery, confirm an indemnification release, or say the chapter is out of beds. SHP eligibility already requires the family to be reachable by phone, text, or email ([Apply](https://shpbeds.org/apply/)).
- **Why it fails:** There is no Twilio or other SMS system in the Keymaster catalog, no SMS egress route, and no SMS ingress. Gatekeeper ingress is Discord-only. Approval adapters for SMS and email are explicitly "Not built" (`docs/APPROVAL_ADAPTERS.md`). A chapter that cannot text from the factory will keep using personal phones, which is worse for offboarding.
- **Fix:** A factory-team SMS system (one chapter number, not a volunteer's cell), with every outbound family text held for approval, templates aligned to the portal's "scheduled delivery" / "application halted" / "no bed inventory" mail, and a transcript stored under the chapter's retention policy.

#### SHP-3 · Blocker · No safeguards for children's and families' private information

- **Trying to:** Use agents on applications and deliveries without leaking a child's name, age, address, or home situation, and without leaving that data behind when a volunteer leaves or a case closes.
- **Why it fails:** Applications and delivery packets include minors' data, addresses, and household conditions. The factory has no data-classification label, no "family record" type, and no "delete this family's data" API or console flow. Declared `retentionDays` is not enforced by the hydrate shim (GAP-116, `docs/architecture/agent-memory-models.md`). Shared team memory for a waitlist is still an open decision (GAP-180 in the same doc), so a chapter either pastes secrets into one person's notebook or invents a spreadsheet. The privilege `conversations.read-others` (`packages/bouncer/src/privileges.ts`) can expose another manager's conversation. The immutable ledger will also retain prompts and held request bodies unless a separate retention process exists.
- **Fix:** A "sensitive case" memory mode: encrypt at rest, named retention and deletion, no `conversations.read-others` by default, automatic holds on any egress that includes an address or a child's name, and a documented purge that covers notebooks, attachments, and exports. Do not enable family-facing agents until this exists and national SHP agrees.

#### SHP-4 · Blocker · No official path through national SHP

- **Trying to:** Adopt a third-party AI factory while remaining a chapter in good standing (insurance, gift receipts, brand, and official systems already run through national).
- **Why it fails:** SHP chapters operate inside national boundaries, "almost like a franchise," with national handling insurance and IRS filings. Official tools already include the Chapter Portal, Golden Volunteers, DonorPerfect, Divvy, and design approval. Nothing in the factory expresses a vendor agreement, a data-processing addendum, an allow-list of official SHP systems, or a "do not store recipient data" policy pack. Putting family records into a shared or unofficial host could violate expectations national has not yet written for this product — and the only running dashboard today is BeerCanLabs' own factory, not a chapter tenant (`GAPS-core.md` CORE-1).
- **Fix:** A written national review path, a hosted single-chapter factory, a standard policy pack (no unofficial receipts, no brand-new logos, no family data until approved), and a clear "Phase 1 only" mode that blocks connectors to applications, addresses, and money.

---

### Major

#### SHP-5 · Major · No DonorPerfect, Divvy, or official finance connectors

- **Trying to:** Help the treasurer log gifts, thank donors with an official receipt, and keep chapter spending straight.
- **Why it fails:** SHP records donations in DonorPerfect, deposits checks to a national PO Box, uses cash deposit forms, spends on Divvy cards, and asks chapters to report PayPal, GoFundMe, and Facebook fundraiser gifts to donations@shpbeds.org ([Finance dashboard](https://shpbeds.org/dashboard/finance/); [Point of contact](https://shpbeds.org/dashboard/poc/)). None of those systems are in `packages/keymaster/src/catalog.ts`. QuickBooks is also absent, and is usually the wrong ledger for a chapter anyway because national files the IRS returns. An agent can draft a thank-you, but it cannot receipt a gift and could easily invent a parallel process.
- **Fix:** After national approval, a read-first DonorPerfect skill and a Divvy-receipt checklist skill. Default behavior: draft the thank-you and a "enter this in DonorPerfect" reminder; never generate a tax receipt; never pay a bill.

#### SHP-6 · Major · No Facebook or Instagram connector

- **Trying to:** Draft and schedule the posts a chapter actually publishes — build-day invitations, bedding drives, volunteer calls — on Facebook and Instagram.
- **Why it fails:** National tells chapters they may have Facebook and Instagram, preferably with matching usernames ([Instagram FAQ](https://shpbeds.org/ufaq/can-my-chapter-add-an-instagram-account/)). The catalog has X and LinkedIn OAuth, with posts intended to wait on approvals (`packages/keymaster/src/catalog.ts`), but not Meta/Facebook or Instagram. X and LinkedIn are the wrong primary channels for most chapters.
- **Fix:** A Facebook/Instagram system with E9 holds, mandatory "photo release checked?" on any image of a child or a home, and a reminder to use the Brand Book and Design Team approval for custom artwork.

#### SHP-7 · Major · No Golden Volunteers or SignUpGenius connector

- **Trying to:** Fill a Saturday build (sign-ups, reminders, waiver status, station roster) from the same list volunteers already use.
- **Why it fails:** SHP adopted Golden Volunteers as its chapter event and volunteer platform ([Golden case study](https://goldenvolunteer.com/success-stories/sleep-in-heavenly-peace/); Chapter Portal "Golden Volunteers" / Golden Events). Some local groups may still use SignUpGenius. Neither appears in the Keymaster catalog or as a registered system. Without a connector, coordinators will paste rosters into chat or a shadow sheet, and waiver status will drift.
- **Fix:** A national-approved, least-privilege Golden Volunteers skill (read sign-ups, draft reminders; a person publishes event changes). Add SignUpGenius only if a chapter still depends on it.

#### SHP-8 · Major · No maps or delivery-routing system, and no safe way to share addresses

- **Trying to:** Plan Saturday delivery routes and send each small team only their stops.
- **Why it fails:** No maps or routing system is in the catalog. SMS to volunteer drivers is also missing (SHP-2). If a lead pastes addresses into a `team-member` or `personal-assistant` notebook, GAP-116 means retention is not enforced, and a volunteer with leftover access could still read them. There is no "time-boxed route packet" that expires after delivery day.
- **Fix:** A routing skill that keeps addresses in a short-lived, lead-only store; the delivery lead approves each team packet; packets expire automatically; volunteers never query the waitlist.

#### SHP-9 · Major · No e-signature path for official waivers and releases

- **Trying to:** Make sure every build volunteer has signed the Build Day & Delivery Volunteer Release, and that a family has signed the indemnification (and photo release when needed) before delivery ([Volunteer](https://shpbeds.org/volunteer-2/); [Delivery resources](https://shpbeds.org/dashboard/delivery/)).
- **Why it fails:** Those forms are official SHP PDFs. The factory has no DocuSign, HelloSign, or similar system, and should not invent a replacement form. An agent that "collects a waiver" in chat would not be the official release.
- **Fix:** Do not replace SHP forms. If national already has an electronic process, hook a status check (signed / not signed) into the coordinator and delivery agents. Otherwise, agents only remind and check a box a person attests to.

#### SHP-10 · Major · Google Workspace is only a foundation, not a volunteer-ready mail or sheet tool

- **Trying to:** Let a fundraising lead connect the chapter Gmail, Calendar, or a roster spreadsheet by clicking "Connect."
- **Why it fails:** Google user OAuth is in the catalog, but it needs a factory-wide Google OAuth client (`google-oauth-client` in `packages/keymaster/src/catalog.ts`). The catalog warns the app may still be in testing and limited to added test users. Every catalog entry is also `approved: null` (pending human review). There is no shipped Gmail, Calendar, or Sheets skill (`skill-defaults.json` is empty). This is factory-team work, not something a chapter treasurer can finish.
- **Fix:** Factory team verifies the Google OAuth app, approves the catalog copy, and ships held-send Gmail plus read/write Sheets skills. Chapters connect the chapter account, not a volunteer's personal Gmail.

#### SHP-11 · Major · Chapter work needs shared memory; the factory keeps per-person notebooks

- **Trying to:** Give application managers one shared triage list, and inventory managers one shared count, without emailing spreadsheets around.
- **Why it fails:** A `team-member` agent keeps each person's conversations separately. Shared project memory is explicitly an open decision (GAP-180, `docs/architecture/agent-memory-models.md`). The official systems (Chapter Portal, Golden, DonorPerfect) are the right shared record, but until those connectors exist, a chapter has no safe in-factory shared workspace.
- **Fix:** Either connect the official systems (SHP-1, SHP-5, SHP-7) and treat them as the shared memory, or build a chapter workspace archetype with role-based views (no addresses for coordinators who do not do applications).

#### SHP-12 · Major · Offboarding does not clear family data a volunteer already saw

- **Trying to:** When an application manager or delivery lead resigns, cut their access the same day and remove family records from anything they used besides the Chapter Portal.
- **Why it fails:** Grants can be revoked (`DELETE /api/v1/grants/:id` in `packages/control-plane/src/grants-routes.ts`) and keys can be revoked (`DELETE /api/v1/keys/:id` in `packages/control-plane/src/keys-routes.ts`), but these are separate steps. CORE-9 already notes that `POST /api/v1/principals/:id/revoke-access` does not revoke long-lived `fk_` keys. Even after access is gone, notebooks, pasted spreadsheets, held-request previews, and the ledger can still contain addresses and children's names, and there is no per-family delete (SHP-3).
- **Fix:** A single "this volunteer left" action: revoke grants, groups, sessions, and API keys; transfer agent ownership; list notebooks and exports that may hold case data; guide a purge. Pair it with the "do not keep applications in personal Gmail" rule in the playbook.

#### SHP-13 · Major · No Spanish (or other language) support for family messages

- **Trying to:** Follow up with families in the same language SHP already offers on the apply page (English and Spanish) ([Apply](https://shpbeds.org/apply/)).
- **Why it fails:** Nothing in the console, souls, or shipped skills makes bilingual templates a first-class feature. A general model can draft Spanish, but there is no reviewed template set, no guarantee it matches official portal wording, and no hold preview that shows both the Spanish text and a back-translation to the approver.
- **Fix:** National-reviewed English/Spanish templates for scheduling, inventory delays, and delivery confirmations, with the official wording preferred over a free-form model draft.

#### SHP-14 · Major · Unofficial money tools (Givebutter, PayPal, personal Venmo) are easy to wire badly

- **Trying to:** Collect a sponsored-build gift or a Facebook fundraiser and thank the donor.
- **Why it fails:** There is no Givebutter or PayPal connector in the catalog. Worse, a well-meaning chapter might create one and start receipting gifts outside DonorPerfect. National already requires third-party platform gifts to be reported to donations@shpbeds.org and official receipts to go through DonorPerfect.
- **Fix:** Do not ship a "take payment" skill for chapters. Ship a checklist skill: identify the source, draft the donations@ notice, remind DonorPerfect entry, draft a thank-you that does not claim to be a tax receipt.

#### SHP-15 · Major · Chapter President's Report and national stats are not in the loop

- **Trying to:** File the Chapter President's Report the same day as a build, with accurate beds-built, volunteers, and deliveries, because national updates weekly stats and uses the numbers for grants ([Staff dashboard](https://shpbeds.org/dashboard2/)).
- **Why it fails:** No connector to the report form or to chapter statistics. An agent can draft the numbers from memory, which is how invented statistics start.
- **Fix:** After national approval, a draft-and-hold flow that pulls counts from Golden Volunteers and the Chapter Portal, shows the math, and leaves submission to the president in SHP's own form.

#### SHP-16 · Major · Brand and photo rules are not enforced at the point of posting

- **Trying to:** Post about a delivery without breaking the Brand Book or publishing a child's bedroom photo without a release ([Design & Marketing](https://shpbeds.org/dashboard/design/); [Media](https://shpbeds.org/media/)).
- **Why it fails:** Even if Facebook posting existed, the factory hold (E9) shows the outgoing request; it does not know whether a photo release is on file or whether a custom graphic was approved by the Design Team. Custom T-shirts and flyers already require a Design Request / Approval form.
- **Fix:** A pre-post checklist baked into the social agent (release on file, faces of minors, custom art, promise of a bed, Design Team). Hold stays on. Optionally, a later hook to SHP design approval.

#### SHP-17 · Major · Approvals happen in the wrong place for SHP volunteers

- **Trying to:** A delivery lead, on a Saturday driveway, approves "text this family that we are 20 minutes away" from a phone, by email or SMS.
- **Why it fails:** Approvals are console or Discord only; Slack, Teams, email, web chat, and links are not built (`docs/APPROVAL_ADAPTERS.md`). Console configuration-change approvals are also "blind" (no preview). Most SHP volunteers will not have Discord or a factory console session on the truck. This is the SHP-specific impact of CORE-4 and CORE-5.
- **Fix:** Email and SMS one-tap approval of the exact outgoing text, with the approver identified as their factory principal (email), not a GitHub login.

---

### Minor

#### SHP-18 · Minor · Scheduled reminders default to America/Los_Angeles

- **Trying to:** Send a Friday-night reminder for a Saturday 9 a.m. build in the chapter's own time zone.
- **Why it fails:** The Timekeeper default time zone is `America/Los_Angeles` when a schedule names none (`packages/timekeeper/README.md`). Chapters exist across the U.S., Canada, Bermuda, and the Bahamas.
- **Fix:** Require an IANA time zone on every chapter schedule and default it from the chapter's location, not from the factory's home zone.

#### SHP-19 · Minor · A shadow inventory or waitlist will drift from the official one

- **Trying to:** Track lumber, mattresses, and bedding in a spreadsheet until a Chapter Portal connector exists.
- **Why it fails:** This is a process risk, not a missing endpoint. The portal already has inventory. A second count will be wrong after the first unrecorded delivery, and families may be promised a bed the chapter cannot complete.
- **Fix:** If a temporary sheet is unavoidable, mark it "unofficial, reconcile after every build and delivery," and retire it as soon as SHP-1 exists. Prefer "type the counts into the agent for this one answer" over a lasting duplicate.

#### SHP-20 · Minor · Model and hosting cost is unexplained in chapter terms

- **Trying to:** Decide whether a $250 sponsored bed is being eaten by monthly AI and hosting bills the chapter did not plan for.
- **Why it fails:** Agents start in `PENDING_BUDGET` until an admin sets policy (`docs/CREATING_AGENTS.md`, `packages/control-plane/src/agent-creation.ts`). Spend views exist for operators, but there is no nonprofit plain-language budget ("this chapter's agents may spend $X per month") and no invoice story a treasurer can put next to Divvy receipts.
- **Fix:** A hosted-plan price in dollars per month, a hard cap the president can see, and a one-page explanation that factory cost is separate from bed cost and is not paid with a Divvy card unless national says so.

#### SHP-21 · Minor · Catalog and console language will stall volunteers

- **Trying to:** Have a volunteer coordinator use the dashboard without learning "cartridge," "egress," "fleet," or "purge."
- **Why it fails:** The Keymaster instruction catalog is entirely `approved: null` (`packages/keymaster/src/catalog.ts`). Console navigation and role names are engineering vocabulary (see CORE-11). There are no SHP templates in `agents/staff` or `agents/examples` (see CORE-12).
- **Fix:** Approve catalog copy, add a simple-mode console, and ship the nine starter agents in this playbook as templates with holds and scopes already set.

#### SHP-22 · Minor · Cron and report helpers do not know SHP's own calendar of obligations

- **Trying to:** Be reminded, automatically, to file the same-day president's report, to check Divvy receipts, or to look at weekly national stat updates.
- **Why it fails:** Schedules exist (`packages/control-plane/src/schedules.ts`, Timekeeper), but there is no SHP obligation pack, and reminders still have no email/SMS delivery (SHP-2, CORE-5).
- **Fix:** A chapter "duty calendar" template (same-day report, monthly DonorPerfect check, pre-build inventory) that notifies the president in a channel they actually read.

---

### Suggested order of work

1. Hosted single-chapter factory and national SHP written rules (CORE-1, CORE-2, SHP-4).
2. Family-data safeguards and a real offboarding button (SHP-3, SHP-12) before any application data is stored.
3. Volunteer-friendly talk-and-approve channels: email and SMS (CORE-5, SHP-2, SHP-17).
4. Official connectors, only with national permission: Chapter Portal, Golden Volunteers, DonorPerfect (SHP-1, SHP-7, SHP-5).
5. Facebook/Instagram with photo-release holds, Google mail/sheets for the chapter account, and routing with expiring packets (SHP-6, SHP-10, SHP-8).
6. Templates, simple-mode UI, bilingual official wording, and a clear monthly price (SHP-13, SHP-21, SHP-20).
