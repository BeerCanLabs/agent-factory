# Connectors and integrations

**Audience:** a mid-sized church (about 400 people) with a preschool (100+ children), and a local Sleep in Heavenly Peace chapter. Neither organization has IT staff.

**How to read status labels**

- **works today** — the factory already has this in code or in the reference AWS landing zone. A person can use it once a factory is running and an admin has finished any one-time platform setup.
- **needs the factory team** — the mechanism exists, but a non-technical church or chapter administrator cannot complete it alone. Someone who can operate the factory (BeerCanLabs, a volunteer engineer, or a future “hosted for you” operator) has to do part of the work.
- **not possible yet** — the factory does not have this path today. Do not promise it to an adopter.

Every factual claim about the product is grounded in the `agent-factory` repo. External nonprofit programs are listed only where they affect *how* an org would obtain Google or Microsoft accounts; they are not factory features.

This guide answers: how would an agent get into email, calendar, Google Workspace, Microsoft 365, Slack or Discord, SMS, spreadsheets, and church or preschool systems — and can a non-technical person do it themselves?

---

## 1. The short answer for both organizations

A factory does not ship a menu of “Connect Gmail” / “Connect Planning Center” / “Connect SMS” apps that a secretary can finish unassisted.

What exists is a **systems catalog** plus a **Keymaster** that stores secrets and OAuth grants. An agent only reaches an outside system if:

1. That system is defined and **approved** in the factory (`GET`/`POST /api/v1/systems`, approval at `POST /api/v1/systems/:id/approve`). See `packages/control-plane/src/systems.ts` and `packages/registrar/src/systems.ts`.
2. The agent’s policy allows the matching egress route.
3. The needed credential is present: either a static secret pasted into a write-only field, or an OAuth “Connect” consent for a person. See `packages/keymaster/src/credentials.ts` and the console Credentials view (`packages/console/src/views/CredentialsView.tsx`).

The AWS landing zone seeds a useful starter set of **Google**, **Discord**, **GitHub**, **Notion**, **LinkedIn**, and **Motion** routes once, from `FACTORY_SYSTEMS_IMPORT` (`landing-zones/aws/variables.tf`, variable `systems_import`). It does **not** seed Microsoft 365, Slack as a system, SMS, Google Sheets, or any church-management or preschool product.

**Can a non-technical person do this themselves?**

- **Paste a token or click Connect for a system that is already approved, after the factory’s OAuth app is configured:** **works today** in the dashboard, with on-screen instructions.
- **Stand up the factory, register a new system (for example Planning Center or Outlook), or create the factory’s Google/LinkedIn/X OAuth client in a developer console:** **needs the factory team**.
- **Talk to parents or volunteers by SMS, use Microsoft 365 as a first-class connection, use Slack as the agent’s mailbox, or hook into a ChMS or preschool SIS out of the box:** **not possible yet**.

---

## 2. How access works in the factory (the model, not a vendor list)

### 2.1 Systems, not “connectors”

External systems other than model providers are **system definitions** (`packages/contract/src/system.ts`). A definition names:

- an `id` (kebab-case, for example `google-gmail`)
- `kind`: `http`, `mcp`, or `ai-provider`
- an `https` `upstream`
- either a **static credential** (API token injected as a header) or a **Keymaster connection** (OAuth user grant or service-account JWT)
- optional **holds** (writes wait for a person’s approval)
- optional size limits and sign-in-link stripping

Admin approval is required for each definition version. The gatekeeper-egress learns the live routes from `GET /api/v1/gatekeeper-egress/routes` (`packages/control-plane/src/systems.ts`).

A new system is not a code change. Someone with `systems.propose` posts a proposal; someone with `systems.decide` (admin) approves it. The Systems view in the console is the UI for that catalog (`packages/console/src/views/SystemsView.tsx`). Designing a correct proposal (URLs, scopes, hold rules) is still specialist work. **Status: needs the factory team** for any system that is not already approved in that factory.

### 2.2 Keymaster: secrets and consent

The Keymaster (`packages/keymaster`) is the only component that handles credential *values*:

- **Static secrets** (bot tokens, API keys) are submitted write-only to `POST /api/v1/keymaster/agents/:agentId/credentials/:name` or, for platform-wide keys, `POST /api/v1/keymaster/platform/credentials/:name` (`packages/control-plane/src/credentials.ts`). The value is stored in the secrets backend and is never shown again.
- **User OAuth grants** live at `connections/<agent>/<provider>`. A signed-in admin starts consent at `GET /api/v1/connections/:agentId/:provider/start` and the provider returns to `GET /api/v1/connections/:provider/callback` (`packages/control-plane/src/connections.ts`, Keymaster logic in `packages/keymaster/src/connections.ts`).
- The factory refreshes access tokens and marks a grant `needs_reconsent` when it is revoked or expired (including providers such as LinkedIn that issue no refresh token).
- The Credentials page lists status only: `present`, `missing`, `needs_consent`, `missing_scopes`, `needs_reconsent`. It never displays a secret.

Instruction text for how to *create* a credential comes from the Keymaster catalog (`packages/keymaster/src/catalog.ts`). Every entry in that catalog is currently `approved: null`, so the API and dashboard show the label “Pending human review: AI-drafted instructions, not yet approved by a person.” The flow still works; the wording is unofficial. **Status: works today** for the submit/consent machinery; **needs the factory team** to review and approve the catalog copy.

### 2.3 Guided app setup (Discord and GitHub only)

A separate “app setup” pattern walks an operator through creating an agent’s Discord bot or GitHub App (`packages/control-plane/src/app-setup-providers.ts`, `discord-app-setup.ts`, `github-app-setup.ts`):

- `GET /api/v1/keymaster/agents/:agentId/app-setup`
- `POST /api/v1/keymaster/agents/:agentId/app-setup/:provider/:step`

The console renders steps without provider-specific UI code: paste a secret, or complete a browser post. **Status: works today** for Discord and GitHub, once someone can sign in to those developer portals. There is no equivalent walkthrough for Slack, Microsoft, Google Workspace admin, SMS, or church software.

### 2.4 The factory’s own MCP endpoint vs an agent calling someone else’s MCP

These are easy to confuse.

- `https://factory-dashboard.dalesackrider.com/mcp` is the **factory control plane** MCP (tools such as `whoami`, waking agents, grants). That is how a client such as Higgins talks *to the factory*. See `packages/control-plane/src/mcp.ts`. **Status: works today** on a running factory, for a signed-in or API-key principal.
- An *agent* can be allowed to call an **external MCP server** if an approved system of `kind: 'mcp'` exists. The gatekeeper-egress implements that kind (`packages/gatekeeper/src/egress/gatekeeper-egress.ts`). The AWS `systems_import` list does not include any MCP systems. **Status: needs the factory team** to propose and approve each external MCP server. There is no self-serve “add this MCP URL” wizard for a non-technical user.

### 2.5 Where credentials live

On AWS, secrets go to AWS Secrets Manager under a prefix such as `factory/prod/` (`packages/secrets-bind/src/index.ts`, `awsSecretsManagerProvider`). GCP Secret Manager and a gitignored env file (Compose) are also supported. Agents never receive provider keys for model vendors; the gatekeeper-egress injects those (S1). **A non-technical person should never paste a secret into email, chat, or a ticket.** The dashboard write-only field is the supported path. **Status: works today.**

---

## 3. What the AWS landing zone already seeds

`landing-zones/aws/variables.tf` (`systems_import`) imports these as approved systems on first boot (`FACTORY_SYSTEMS_IMPORT` in `landing-zones/aws/ecs.tf`; import logic in `packages/registrar/src/systems.ts`). An admin’s later edits are not overwritten.

| System id | What it reaches | Credential | Relevance to these orgs |
|---|---|---|---|
| `google` | Google OAuth (accounts.google.com) | OAuth user; factory client at `GOOGLE_OAUTH_CLIENT` / `shared/google/oauth-client` | Required before any personal Google grant |
| `google-gmail` | Gmail API | Connection `google` | Church office email, chapter email, if the mailbox is Gmail or Google Workspace |
| `google-calendar` | Calendar API v3 | Connection `google` | Staff calendars, sanctuary and classroom booking, delivery windows |
| `google-drive`, `google-drive-upload` | Drive API v3 | Connection `google` | Shared folders, sermon notes, chapter documents |
| `google-storage` | Cloud Storage | Google service account (JWT) | Rarely needed by a church or SIP chapter |
| `google-health` | health.googleapis.com | Connection `google` with fitness/sleep scopes | Not a church or SIP need |
| `google-oauth`, `google-service-account` | Token endpoints / service-account support | Platform secrets | Platform plumbing, not an end-user app |
| `discord` | Discord HTTP API | Per-agent bot token `{agent}_DISCORD_BOT_TOKEN` | Only useful if the org actually uses Discord |
| `github` | GitHub API | Per-agent token | Software teams; not a typical church or SIP need |
| `notion` | Notion API | Platform `NOTION_API_KEY` | Possible for internal notes if they already use Notion |
| `linkedin` | LinkedIn API | OAuth user; writes are **held** for approval | Possible for public posts; 60-day grant with no refresh token (`packages/keymaster/src/catalog.ts`) |
| `motion` | Motion calendar/tasks API | Platform `MOTION_API_KEY` | Only if the org already pays for Motion |

There is also a catalog (instructions only, not a seeded HTTP system) for **Slack**, **xAI**, **Anthropic**, **Home Assistant**, **X (Twitter)** OAuth, and platform OAuth clients for Google, LinkedIn, and X (`packages/keymaster/src/catalog.ts`).

**Status: works today** for the seeded Google / Discord / GitHub / Notion / LinkedIn / Motion routes, after the one-time platform secrets and (for Google) the factory OAuth client are in place. **Status: needs the factory team** for that one-time Google Cloud / LinkedIn / X developer-app setup.

---

## 4. Channel by channel: what an adopting org will ask

### 4.1 Email (Gmail / Google Workspace)

**What they want:** an agent that reads the office inbox, drafts replies, files messages, and sends mail in the church or chapter’s name — with a person approving anything that goes out, if required.

**What exists:** `google-gmail` is a seeded HTTP system using the `google` OAuth connection. After the factory’s Google OAuth client is stored (`google-oauth-client` catalog entry; `POST` of the client JSON to the platform credential endpoint), a person clicks **Connect** on the agent’s Credentials page, signs in at Google, and grants only the scopes that agent declares. The factory never sees the Google password. Re-consent is prompted when scopes are missing or the grant is revoked.

**Holds:** a system *can* mark write methods as held (LinkedIn already does this in `systems_import`). The seeded `google-gmail` definition does **not** set a `hold` on POST. If the church wants “never send mail until a person approves,” an admin must edit and re-approve that system. **Status: needs the factory team** to add that hold if it is required.

**Limits:**

- This is the Gmail API, not a generic “any email account” connector. A mailbox at Outlook, Yahoo, or a self-hosted IMAP/SMTP server is **not possible yet** as a first-class connection.
- There is **no inbound email mailbox** that wakes an agent when someone *emails the agent*. Approvals also cannot be completed by email (`docs/APPROVAL_ADAPTERS.md`: Slack, Teams, web chat, email, and magic links are “Not built”). If the secretary never opens the factory dashboard or Discord, they cannot approve a held action. **Status: not possible yet** for “email the bot” or “approve by hitting reply in Outlook.”
- Google may block sign-in while the factory’s OAuth app is unverified; an administrator must add test users in Google Auth Platform (`packages/keymaster/src/catalog.ts`, `google` entry). **Status: needs the factory team.**

**Can a non-technical person finish it?** After the factory team has placed the Google OAuth client and approved the Gmail system: **yes**, they can click Connect and paste nothing. Getting to that point: **no**.

### 4.2 Calendar

**What they want:** see staff and room calendars, propose times, book a fellowship hall or a bed-build Saturday, avoid conflicts with preschool pickup.

**What exists:** `google-calendar` is seeded, same Google grant as Gmail if scopes are requested together (`include_granted_scopes=true` on the Google OAuth system). **Status: works today** for Google Calendar after the same one-time OAuth client setup.

**Microsoft Outlook calendar, Planning Center calendar, Apple iCloud, and Motion** (unless they already use Motion and have pasted `MOTION_API_KEY`): **not possible yet** as seeded systems, except Motion, which **works today** as a static platform key if they subscribe to Motion.

### 4.3 Google Workspace (Drive, docs, shared drives)

**What they want:** agents that can find a policy PDF in the church shared drive, update a volunteer roster doc, or drop a delivery checklist in a folder.

**What exists:** `google-drive` and `google-drive-upload` are seeded on the same `google` connection. **Status: works today** after OAuth client setup and Connect.

**Google Sheets as a first-class API** (read/write tab cells, the usual SIP chapter “source of truth” spreadsheet) is **not** in `systems_import` and is **not** in the instruction catalog. Drive can store a Sheet file, but the Sheets API is a different upstream (`sheets.googleapis.com`) and would be a new system proposal. **Status: not possible yet** out of the box; **needs the factory team** to propose and approve a `google-sheets` system that reuses the `google` connection. That is a small, well-understood addition, not a new product.

**Google Workspace admin** (creating users, resetting a preschool teacher’s login) is not a seeded system. **Status: not possible yet.**

### 4.4 Microsoft 365 (including nonprofit grants)

**What they want:** the same as Gmail/Calendar/Drive, but on Outlook, Teams, OneDrive, SharePoint, and Excel — which is what many churches already received through [Microsoft 365 Business Basic for nonprofits](https://www.microsoft.com/en-us/nonprofits/offers-for-nonprofits) (grant of up to 300 Business Basic licenses for eligible orgs; confirm current terms on Microsoft’s site).

**What exists in the factory:**

- The *schema* allows an `oauth-user` system against `login.microsoftonline.com` (`packages/contract/src/system.test.ts` includes a Microsoft URL as a valid proposal).
- Identity providers the factory can *sign humans into the dashboard with* include generic OIDC (`packages/control-plane/src/idp-config.ts`, `IDP_KINDS = google | meta | cloudflare | oidc`), so Microsoft Entra *could* be configured as the operator login. That is sign-in to the factory, not Graph API access for agents.
- There is **no** seeded Microsoft system, **no** Microsoft entry in `INSTRUCTION_CATALOG`, **no** app-setup provider, and **no** Microsoft Graph routes in `systems_import`.

**Status: not possible yet** as a productized integration. An engineer could propose systems and register an Entra app; that is **needs the factory team**, and it is not a documented, click-through path for a church administrator. Nonprofit grants help the *org* obtain Microsoft 365; they do not connect it to the factory by themselves.

### 4.5 Slack and Discord

**Discord — as a mailbox (people talk to the agent):** **works today**, and is the only chat ingress. `gatekeeper-ingress` is a Discord module (`packages/gatekeeper/src/ingress/discord.ts`). It is idle until a cartridge declares a Discord surface *and* a bot token is bound (`README.md`, `SPEC.md`). The token is pasted in the Credentials view or completed through Discord app-setup. Approvals can be given by a Discord DM reply (`docs/APPROVAL_ADAPTERS.md`).

For a church preschool or a SIP chapter this is often a poor fit: staff, parents, and volunteers usually do not live in Discord, and a preschool should not put family conversations in a volunteer Discord server. **The feature works; the channel may not be acceptable.**

**Slack — as a mailbox:** **not possible yet.** `SPEC.md` states that Slack RTM and true TCP socket transfer “remain deferred.” `docs/APPROVAL_ADAPTERS.md` lists Slack as “Not built.” Ingress source files are Discord and HTTP only (`packages/gatekeeper/src/ingress/`).

**Slack — as an egress API** (post to a channel with a bot token): the catalog has unapproved instructions for creating a Slack app and pasting an `xoxb-` token (`packages/keymaster/src/catalog.ts`, id `slack`). There is **no** seeded `slack` system in `systems_import`. **Status: needs the factory team** to propose and approve a Slack HTTP system; then a non-technical admin could paste the token. That still does not make Slack a mailbox or an approval channel.

**Microsoft Teams:** **not possible yet** (no ingress, no catalog, no system).

### 4.6 SMS and voice

**What they want:** text the Saturday build crew, text a parent that pickup is running late, send a delivery-window reminder.

**What exists:** nothing in the catalog, systems import, ingress, or approval adapters for Twilio, WhatsApp, or carrier SMS. **Status: not possible yet.** This is a likely blocker for SIP volunteer dispatch and for preschool-to-parent messaging unless they already route those through email or a ChMS the factory also cannot reach.

### 4.7 Spreadsheets

See §4.3. Drive **works today** (Google). Excel Online / Microsoft Graph and a first-class Google Sheets system are **not possible yet** without a new approved system. Many SIP chapters run the build list, inventory, and delivery roster in a shared spreadsheet. Until a Sheets (or Excel) system exists, an agent cannot reliably update cells; asking the agent to “edit the Sheet via Drive file upload” is not the same and should not be promised.

### 4.8 Church management (ChMS) and preschool systems

**What they want:** Planning Center, Church Community Builder, FellowshipOne, Breeze, Pushpay/CCB, and on the preschool side Procare, Brightwheel, KidReports, or a state attendance/licensing tool — people, kids, rooms, check-in, tuition, parent messaging, background-check flags.

**What exists:** none of these appear as systems, catalog entries, or app-setup providers anywhere in the repo (search of `packages/`, `landing-zones/`, and `docs/`). **Status: not possible yet.**

A factory *could* add one as a generic `http` or `mcp` system if the vendor has an API and the org can obtain a key. That requires the factory team to write a correct system proposal (upstream, credential header, holds for any write that touches child or pastoral data) and an admin to approve it. Child data also needs a policy conversation (who may see it, audit, retention) that the product does not encode as a preschool-specific control.

Until that work is done, do not tell a preschool director that an agent can take attendance or message parents inside their existing tool.

### 4.9 Other channels they may ask about

| Ask | Status | Notes |
|---|---|---|
| Notion workspace | **works today** (seeded) after pasting the integration secret and sharing pages with the integration | Catalog instructions exist (unapproved copy) |
| LinkedIn or X posts in the org’s name | **works today** after platform OAuth client setup; writes held on LinkedIn | LinkedIn grants expire in 60 days and need reconnect |
| GitHub | **works today** with guided app-setup | Unlikely need for these orgs |
| Facebook / Instagram pages | **not possible yet** | Meta appears only as a *dashboard* IdP kind, not as a Page publishing system |
| Bank, card, or donor-management (Planning Center Giving, Pushpay, QuickBooks) | **not possible yet** | No catalog or system |
| Home Assistant | Catalog instructions only | Not relevant here |
| “Approve it from my phone email or Slack” | **not possible yet** | Console or Discord only (`docs/APPROVAL_ADAPTERS.md`) |

---

## 5. What a non-technical administrator can actually click

Once a factory is already running and they can sign in to the dashboard:

1. Open the agent → **Credentials**. Outstanding items are listed with instructions and a status badge (`CredentialsView.tsx`).
2. For a static token: paste into the write-only box and save. The value is cleared from the form and is never shown again.
3. For Google (or LinkedIn / X, if configured): click **Connect**, finish consent on the provider’s site, return to the factory.
4. For Discord or GitHub: follow **App setup** steps in the same console.
5. Watch Approvals in the console (or Discord DM, if that is how they talk to the agent).

They cannot, from that UI alone:

- Create the factory or a new organization
- Create the Google Cloud OAuth client, verify the app, or add test users
- Add Microsoft 365, Slack-as-mailbox, SMS, Sheets, or Planning Center
- Approve a new system definition unless they have already been given the admin role *and* understand the proposal
- Recover a pasted secret (it is write-only; they must rotate at the provider and paste again)

**Bottom line:** credential *entry* is designed for a non-developer. Connector *onboarding* of a new vendor, and all hosting, is not.

---

## 6. Implications for the two example organizations

**Church + preschool.** If the office already runs Google Workspace, a carefully scoped agent can work with Gmail, Calendar, and Drive after the factory team completes OAuth app setup. It cannot be the preschool’s information system, cannot text parents, and should not be asked to live in Discord if that is not already the staff culture. Microsoft-first churches are blocked on the productivity suite until a Graph integration is built. Anything that touches children’s records needs a held-write policy and a system that does not exist yet.

**Sleep in Heavenly Peace chapter.** Volunteer coordination by email and a shared Google Drive folder is the realistic starting point. The almost-certain source of truth — a spreadsheet of beds, kids, and delivery routes — is a gap until a Sheets system is approved. SMS to volunteer crews is a gap. If the chapter’s email is Microsoft 365, email itself is a gap. National or chapter-specific SIP software, if any, is unknown to the factory and would be a new system.

In both cases, someone still has to *give them a factory*. That is the subject of `hosting-and-setup.md`.
