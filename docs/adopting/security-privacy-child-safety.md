# Security, privacy, and child safety

**Audience:** a mid-sized church with a licensed preschool (100+ children), and a local Sleep in Heavenly Peace (SHP) chapter. Neither organization has IT staff. This guide is written for a pastor, preschool director, SHP chapter president, or board/elders, not for engineers.

**How to read the status tags.** Every factual claim about the factory is tagged:

- **Works today** — this behavior is in the current factory (control plane, console, gatekeeper, and speak-as). A person who can sign in can use it, sometimes only with help to click the right screen.
- **Needs the factory team** — the product can do this, but someone who runs the factory has to set it up or operate it (hosting, sign-in, model providers, egress policy, hold rules). A church or chapter admin cannot do it alone.
- **Not possible yet** — the product does not have this. Do not plan a process that depends on it.

Citations in backticks are file or API paths in the Agent Factory repository.

**This is not legal advice.** The law section at the end is a plain-language orientation with links to official sources, so your board can ask the right questions of a lawyer who knows nonprofit, education, and childcare rules in your state. It is not a determination that any law does or does not apply to you, and it is not a compliance program.

---

## 1. The short version

The factory is built around a few strong ideas that **work today**:

- People sign in as themselves. Privileges come from *roles and grants*, never from a privilege pasted onto one person (`packages/bouncer/src/privileges.ts`).
- An agent cannot go out to the internet, a model vendor, or a messaging system unless an admin has allowed that route and host. Registration grants nothing (**E7**, deny-by-default; `packages/control-plane/src/app.ts`).
- When a route or skill action is marked to be held, the gatekeeper will not send the request until a person approves the exact copy (**E9**; `packages/gatekeeper/src/egress/gatekeeper-egress.ts`, `packages/bouncer/src/approvals.ts`).
- The factory can enroll household-style speakers and, if you mark someone as a **child**, it will refuse agent-to-agent calls and errands and will only connect them to a named list of agents (`docs/SPEAK_AS.md`, `packages/bouncer/src/speak-as.ts`).
- Access changes, key issue/rotate/revoke, denied authorization, and an admin reading someone else's conversation are written to an append-only ledger. Secrets and message bodies are not supposed to go in that ledger (`packages/ledger/src/sanitize.ts`, `packages/control-plane/src/keys-routes.ts`, `packages/control-plane/src/app.ts` AM5).

Those controls are necessary, but they are not enough for a preschool or for SHP family addresses on their own. Several gaps would make safe adoption difficult or blocked. The most important:

- There is **no** parental-consent, parent-review, or “delete this child’s data” workflow (**not possible yet**).
- If a child (or a teacher talking about a child) types allergies, a pickup restriction, an address, or a name into a chat, that text can be sent to whatever AI provider the agent is allowed to call (**works today** as a risk; there is no child-data flag or automatic block).
- “Kid-safe mode” is real for *who a child may be connected to* and *no errands*, but the “kid-safe tone” is guidance in the speak-as document, not a content filter the factory enforces (`docs/SPEAK_AS.md` vs `runtimes/agent-runtime/runtime/loop.py`).
- Speak-as trusts the client (robot or connector) when it names the speaker. The factory does not check a voice, a PIN, or a parent’s presence (`docs/SPEAK_AS.md`).
- Staff without IT skills cannot fully manage speak-as, scoped keys for someone else, or outbound-approval policy from the dashboard alone (**needs the factory team** / **not possible yet** in the console).

**Practical rule for both organizations until the gaps close:** do not let children talk to an agent, and do not put preschool records, pickup/custody notes, allergy lists, SHP recipient addresses, donor lists, or background-check results into any agent conversation, skill, or connected drive.

---

## 2. Who can see and do what

### 2.1 How identity works

**Works today.** A request is identified in this order (`identify()` in `packages/control-plane/src/app.ts`):

1. A factory API key (`fk_…`) already checked before routing (`verifyApiKeyBeforeRouting`).
2. Otherwise a `Authorization` bearer (OIDC or a configured token).
3. Otherwise the factory’s own sign-in cookie (HttpOnly session).
4. Otherwise a Cloudflare Access assertion.

The key’s *owner* is the actor. Scopes on a key can only **narrow** what that owner may already do; they cannot grant extra power (`identify()` comment, S5). An API key is forbidden from creating, rotating, or revoking keys; that requires a signed-in person (`POST /api/v1/keys` in `packages/control-plane/src/keys-routes.ts` returns 403 “API keys cannot manage API keys; sign in”).

An admin may act as another person (`onBehalfOf`). That is ledgered on grant and people changes.

**Needs the factory team.** Sign-in providers (Google, Cloudflare, or another OIDC issuer) are configured on the factory (`packages/control-plane/src/login.ts`, `idp-config.ts`). A church cannot add “sign in with our Google Workspace” by itself. Optional `allowedDomains` can restrict which email domains may sign in (**works today** in code, **needs the factory team** to set).

**Known bug, still present.** `GET /api/v1/whoami` labels how you signed in with: “if this request has an `Authorization` header, say `api-key`, else use the session’s IdP, else say `cloudflare-access`” (`packages/control-plane/src/grants-routes.ts`). That does not look at the pre-verified `fk_` key map, and it has been observed to mislabel `fk_` Bearer calls as `signedInWith: "cloudflare-access"`. Do not use that label as an audit of how a device authenticated.

### 2.2 Factory roles (fleet)

These are the human fleet roles the People & Access screen can grant (`FLEET_HUMAN_ROLES` in `packages/bouncer/src/grants.ts`; console list in `packages/console/src/views/people-model.ts`):

| Role | What it can do, in plain language | Status |
| --- | --- | --- |
| **viewer** | See agents, runs, spend, the ledger, approvals, skills, and connections. Can submit a draft and manage a personal model subscription. Cannot wake or talk to agents as an operator. | **Works today** |
| **operator** | Everything a viewer can do, plus wake, pause, reset, isolate, cancel runs, **talk to agents**, write schedules, and create agents. | **Works today** |
| **approver** | Viewer plus one special power: admit *content* (an agent or skill draft) into the factory. This is **not** the person who approves a message an agent wants to send. | **Works today** — the name is easy to misunderstand |
| **admin** | Almost everything: people and grants, keys for others, policy, credentials, reading another person’s conversations, fleet pause, and deciding held actions in the console. | **Works today** |
| **budget-owner** | Allocate model budget. A treasurer-style role. | **Works today** |

Machine-only roles (`ingest`, `gatekeeper-egress`, `gatekeeper-ingress`) are for factory infrastructure, not for staff. The ingress role is the only one allowed to say who sent a chat message or who replied to an approval in a channel (`approvals.channel`, `runs.attest-requester` in `packages/bouncer/src/privileges.ts`). That is intentional: a staff operator must not be able to name the requester.

**Works today.** The factory will not let you revoke or downgrade the last human admin (`409 last_admin` in `packages/bouncer/src/grants.ts`). Always keep at least two admins so a departure or a lost password does not lock the organization out.

**Not possible yet.** There is no first-class “volunteer,” “teacher,” “parent,” or “chapter member” role. If you grant a volunteer **operator**, they can talk to agents and create them. If you grant nothing, they cannot use the console in a useful way (a signed-in person with no grant sees only a no-access screen). See the governance guide for a recommended mapping, and `GAPS-security.md`.

### 2.3 Agent-scoped roles

**Works today.** Separately, a person can be granted a role on one agent (`member`, `accountable-lead`, `content-owner`, `agent-member` in `people-model.ts`). That is how you give a ministry lead or a preschool director power over *their* agent without making them a factory admin.

### 2.4 Who can read someone else’s conversations

**Works today.** Talking to an agent uses `agents.converse`. Reading **another** person’s conversation requires `conversations.read-others`, which only **admin** holds (`packages/bouncer/src/privileges.ts`, enforced in `POST /api/v1/agents/:id/conversation-requests` in `packages/control-plane/src/app.ts`). That read is always written to the ledger (action names the subject, not the chat text).

For a preschool, that means any factory admin can open a family’s or a child’s conversation history. There is no extra “child-record” permission, no two-person rule, and no time limit. Treat the admin role as access to sensitive pastoral and family data, even though the ledger will show that the read happened.

### 2.5 Groups and domain-wide grants

**Works today.** You can grant a role to a whole email domain (`domain:church.org`) or to a group. That is convenient and dangerous: anyone who later signs in with that domain can inherit the grant. Offboarding a person does not remove a domain grant, and their leftover API key is powerless only if they have **no remaining grants** — a domain grant can still apply (`packages/control-plane/src/grants-routes.ts` comments on revoke-access). Prefer grants to named people.

---

## 3. Inviting and removing people

### 3.1 Adding a person

**Works today.** An admin (privilege `grants.manage`) uses People & Access, or:

- `POST /api/v1/principals` — name and email
- `POST /api/v1/grants` — role and scope (fleet or one or more agents)
- optional extra emails on the principal

The console form is “Add person” (`packages/console/src/views/PeopleView.tsx`). Adding a person does **not** send them an invite email (**not possible yet**). Someone has to tell them the dashboard URL and that they must sign in with **exactly** that email through the configured provider.

**Works today, with a limit.** A principal can be created without an email (used for a child speaker who will never sign in; `packages/bouncer/src/principals.ts`). That is a directory entry, not a sign-in account.

### 3.2 Removing access (offboarding)

**Works today.** `POST /api/v1/principals/:id/revoke-access` with `{ "confirm": "<id>" }` (People & Access → revoke all access) does one confirmed action (`revokeAllAccess` in `packages/control-plane/src/grants-routes.ts`):

- Revokes every grant the person holds (fleet and scoped), refused with `409 last_admin` if they are the last human admin.
- Removes them from groups.
- Ends their dashboard sessions and revokes CLI login tokens (`deviceFamily: 'cli'`).
- Writes `GRANT_REVOKED` and `ACCESS_REVOKED_ALL` to the ledger.
- Leaves the person record in the directory so you can grant access again later.

**It does not:**

- Revoke long-lived `fk_` API keys (“they hold no power without grants”; same function). You must revoke those separately in Your API Keys / `DELETE /api/v1/keys/:id`.
- Delete their conversation memory in agents.
- Unenroll them from speak-as grants (`DELETE /api/v1/speak-as-grants/:id/members/:principalId` is a separate admin step; **no console screen**).
- Remove a domain-wide grant that still covers their email.

**Not possible yet.** There is no “delete this person and every trace of their data” API. See §8 and `GAPS-security.md`.

A full offboarding checklist is in `governance.md`.

---

## 4. API keys, explained simply

An API key is a password for a program (a connector, a robot, a script), not for a person clicking the dashboard.

**Works today.**

- Keys are issued, rotated, and revoked at `POST/GET /api/v1/keys`, `POST /api/v1/keys/:id/rotate`, `DELETE /api/v1/keys/:id` (`packages/control-plane/src/keys-routes.ts`).
- The secret is shown **once** on create or rotate and is not stored in the clear. The console says “Copy this key now. It will not be shown again” (`packages/console/src/views/KeysView.tsx`).
- A person may manage keys they own. An admin may manage anyone’s, including `service:…` and `agent:…` keys (the agent must already be registered).
- Device families in the console are `cli`, `mcp`, `service`, and `automation`. There is no “this key may only talk to agent X” picker in the UI.
- Key issue, rotate, and revoke are ledgered (`KEY_ISSUED`, `KEY_ROTATED`, `KEY_REVOKED`) with the key id and owner, never the secret.
- A “break-glass” key, if used, is ledgered and raises a banner until it is rotated.

**Needs the factory team / admin session, not the Keys screen.** The console “Your API Keys” view calls `issueKey(deviceFamily)` with **no owner and no scopes** — it always issues a key for the signed-in user (`packages/console/src/api/client.ts`, `KeysView.tsx`). To issue a scoped key for Stephanie, a preschool kiosk, or `agent:rosie`, an admin must be signed in (session, OIDC, or Access — not an API key) and call `POST /api/v1/keys` with `owner`, optional `scopes`, and optional `roles`. That is how the product works; it is not something a church secretary can do from the dashboard.

**Do:** treat a key like a house key. Store it in a password manager, not in email or a shared spreadsheet. Rotate it if a laptop is lost. Revoke it when a volunteer leaves, even after “revoke all access.”

**Do not:** mint a key with admin roles for a shared front-desk computer; ask the factory team for a narrowly scoped key if you truly need one.

---

## 5. Approvals before agents send anything

This is the control a board should care about most after “who is an admin.”

### 5.1 What is actually held

**Works today, when configured.** The gatekeeper will park a request and wait for a person when:

- The **route** itself has a hold on those HTTP methods (operations config, **E9**; example: writes that act in a person’s name on LinkedIn or X in `packages/hydrate/src/gatekeeper-egress-env.ts`), or
- An adopted **skill action** declares `hold: true` (there is no default; the skill must say true or false; `packages/contract/src/skill.ts`). A hold can be tightened to required but not loosened (`422 hold_loosening_forbidden`).

The person is shown the factory’s stored copy of what will be sent, not the agent’s description (`packages/control-plane/src/channel-approvals.ts`). One approval releases that exact request once. MCP tools on a `requireApproval` list are also parked (`checkToolApproval` in `packages/bouncer/src/decisions.ts`).

**Needs the factory team.** Deny-by-default means a new agent cannot send anything until an admin allows routes — and those routes are **not** automatically “ask a person first.” If an admin allows an email, Discord, or HTTP route without a hold, the agent can send without asking. There is no factory-wide switch that means “every outbound message to a family, donor, or school parent requires a human click.”

**Not possible yet.** Approval adapters exist only for the **console** and **Discord direct messages**. Slack, Teams, web chat, email, and one-tap links are “Not built” (`docs/APPROVAL_ADAPTERS.md`). A preschool director who does not use Discord will have to sign in to the dashboard (and today the Approvals screen enables Approve/Reject only for a global **approver** or **admin**; an agent owner or the person who asked the run is allowed by the API, but the console buttons do not light up for them).

### 5.2 What this means for the church and for SHP

Plan on: “an agent may draft, a named human must send.” Until email and SMS approvals exist, do not promise families that a bot will email them safely. Discord is a poor fit for most church and chapter volunteers.

Decision holds for some configuration changes also name approvers as GitHub logins (see `GAPS-core.md` CORE-4). That is a blocker for these organizations.

---

## 6. Speak-as and kid-safe mode

Speak-as lets a client (in the current product, a household robot or an agent such as Rosie) open a conversation **as** an enrolled person. The receiving agent sees the human as the speaker, not “Rosie on behalf of Dale.” There is no `onBehalfOf` on the delivered caller (`docs/SPEAK_AS.md`).

### 6.1 What the factory enforces today

**Works today.**

- An admin (`grants.manage`) creates a standing grant: `POST /api/v1/speak-as-grants`, plus enroll / unenroll / revoke (`packages/control-plane/src/speak-as-routes.ts`; CLI `factory speak-as …`).
- On each new conversation the client must send `speaker` (an enrolled user id or alias). The factory checks an active, unexpired, unrevoked grant, resolves the speaker, and checks that member’s `targetAgents` allowlist (omitted or empty means every agent — except for children).
- It strips any client-supplied `caller` / `onBehalfOf` and stamps a delivered caller: `actor`, `verified: true`, `channel`, `via` (the client, transport only), `assurance`, `mode`, optional `name` and `relationship`.
- `relationship` may be `owner`, `family`, or `child`. Owner gets `isOwner` and agent role `Owner`; family gets `Family`; a child gets neither (`privilegesForSpeakAsRelationship` in `packages/bouncer/src/speak-as.ts`).
- A **child** member **must** have a non-empty `targetAgents` allowlist (`400 child_requires_allowlist`). Connecting a child to any other agent, or starting `mode: "errand"` / agent-to-agent calls, is `403 child_restricted` (store + `packages/control-plane/src/speak-as-converse.ts`). The runtime also refuses those tools if the stamped caller is a child (`runtimes/agent-runtime/runtime/skills.py`, `examples/skills/agent-connect/agent_connect.py`).
- Follow-up turns cannot change speaker or mode on an open call.

### 6.2 What is weaker than the name “kid-safe” suggests

- **Tone is not enforced.** The speak-as guide tells the agent to “use a kid-safe tone” (`docs/SPEAK_AS.md`). The runtime’s verified-caller prompt lists `relationship=child` and says to use only this caller’s data; it does **not** inject a safety policy or a banned-topic list (`format_verified_caller` in `runtimes/agent-runtime/runtime/loop.py`). Whatever the model would say, it can say, unless you write it into that agent’s own instructions and hope the model obeys.
- **The factory does not identify the child.** “Speaker identification (voice ID, a spoken name, or a PIN) happens on the robot / Rosie. The factory accepts an asserted enrolled user id or alias; it does not perform biometrics.” `assurance` (for example `voice-asserted` or `pin`) is metadata, not a second check (`docs/SPEAK_AS.md`).
- **Omitting `relationship` is allowed** for members who are not marked `child`. Those people can be connected to every agent if `targetAgents` is empty. A mistaken enrollment of a minor without `relationship: "child"` gets none of the child restrictions.
- **No console.** There is no People & Access panel for speak-as grants. Enrollment is admin API or CLI. A church without IT staff cannot operate this safely alone (**needs the factory team** to set up, **not possible yet** as a simple screen).
- The relationship model is **household** (owner / family / child), not teacher / parent / volunteer / enrolled child of a preschool.

**Recommendation (both orgs):** do not enroll children as speak-as members and do not place a voice client in a classroom, nursery, or delivery home until the factory team has closed the gaps in `GAPS-security.md`. Adults on staff may use speak-as only with a tight agent allowlist, a short expiry, and a named admin who can revoke the grant.

---

## 7. Children’s and family data

This covers preschool enrollment, attendance, allergies, custody and pickup authorizations, parent phone numbers, and SHP recipient names and delivery addresses (households with children).

**What the factory is today.** It is a place where agents talk, remember, and call tools. It is **not** a student-information system, a licensing record-keeping product, or a case-management system. It has no record type for “allergy,” “authorized pickup,” or “delivery address,” and no extra lock for those fields (**not possible yet**).

**If that data is pasted into a chat or a connected file, then today:**

- A personal-assistant or team-member agent may **keep it in memory**, keyed by the verified caller when the cartridge is written correctly (`docs/architecture/agent-memory-models.md`). Unverified callers are supposed to get an answer and no memory. Cartridges are responsible for partitioning; the factory does not open the notebook itself.
- The next model call can **send that memory and the new message to the AI provider** allowed on the agent’s policy (see §9).
- If an egress route is allowed without a hold, an agent might **repeat** that data in an email, a Discord message, or another tool.
- A factory **admin** can request another person’s conversation list or turns (ledgered, as above).
- A **viewer** or above can see ledger metadata (who, when, which agent), not the chat text.

**Cartridge `retentionDays` is not enforced by the factory** (documented as GAP-116 in `docs/architecture/agent-memory-models.md`). There is no “delete this child’s conversations across agents” button (**not possible yet**). Purging an entire agent is a two-stage retire (`RETIRED_PENDING_PURGE` then purge) and destroys that agent, not one family’s records.

**Do not** use the factory as the system of record for:

- Preschool enrollment or immunization files
- Allergy or medication information
- Custody orders or “who may pick up this child”
- SHP application forms or delivery addresses
- Counseling or pastoral care notes about a minor

Keep those in the systems your licensing rules and insurers already expect (your preschool software, locked paper, SHP’s chapter process). If you later connect those systems, ask the factory team for a read-only, hold-on-write design and a legal review first.

---

## 8. Donor data, and background-check data

**Donor data (church offerings, SHP fundraising).** **Not possible yet** as a protected class of data. Treat donor names, amounts, and addresses like any other text the agent sees. Do not connect a giving platform in a way that dumps a donor report into an agent’s memory. Do not ask an agent to “thank last week’s donors” by pasting the export into chat.

**Payment cards.** The factory is not a card processor. Putting a card number in a chat would still place cardholder data on the factory, the agent memory, and the model vendor, and can pull you into PCI DSS obligations (see §13). Train staff never to type card numbers into an agent. There is no automatic card-number block (**not possible yet**).

**Background-check data (staff, preschool workers, SHP delivery volunteers).** Fingerprint results, central-registry letters, and “cleared / not cleared” packets are confidential under state childcare rules (in Arizona, for example, certain certification forms are confidential by statute). The factory has no vault or retention rule for this (**not possible yet**). Do not upload packets to an agent, a shared drive the agent can read, or a ticket an agent triages. Keep them in the locked process you already use for licensing.

---

## 9. Where data and model calls go

**Works today**, in outline:

1. A person talks to an agent (console, Discord, MCP, or speak-as). The factory records a run and a verified caller when it can.
2. The agent runtime sends model requests through the **gatekeeper egress**, not straight to a vendor. The egress checks the run token, the agent’s policy (routes and host allowlists), injects the vendor credential, and meters usage (`packages/gatekeeper`, `docs/NETWORK_ISOLATION_AND_EGRESS.md`). An agent with no policy has no egress (SPEC: deny-by-default).
3. Built-in AI vendor kinds include OpenAI, Anthropic, and Gemini (plus subscription / “bring your own” model connections an admin sets up) (`packages/control-plane/src/ai-providers.ts`, model catalog / executive package). The factory can log which model was requested and which upstream model was actually called; it stores a **hash** of a final answer, not the answer text (`packages/ledger/src/sanitize.ts`, `replySha256`).
4. Agent “mind” / memory lives with the agent’s workspace and is hydrated from object storage when the factory is deployed that way (`docs/architecture/agent-memory-models.md`). Exact bucket names and regions are a deployment choice (**needs the factory team**).
5. The control plane keeps principals, grants, keys (hashed), speak-as grants, sessions, approvals, and similar records in its data directory or a configured store (`packages/control-plane/src/index.ts`).
6. The **ledger** is an append-only chain with optional write-once checkpoints to S3 Object Lock or GCS bucket retention (`packages/ledger/src/checkpoints.ts`; default retention days is a deploy setting, commonly 365). Checkpoints in S3 compliance mode cannot be deleted by anyone, including the operator, until the retention period ends.

**What a model vendor can see.** Whatever is in the prompt: the current message, earlier turns the agent loaded, and any tool results the agent fetched. If a teacher pastes a classroom list, the vendor sees it. The factory does not currently offer “this agent may only use an on-prem or a zero-retention model” as a one-click preschool preset (**needs the factory team** to restrict the catalog and policy by hand; **not possible yet** as a child-data mode).

**Needs the factory team.** A written list of subprocessors (model vendors, cloud account, email/Discord, sign-in provider) and any data-processing agreement for your organization. The product does not generate that packet for a board.

---

## 10. Audit logs

**Works today.** The ledger (`packages/ledger`) records actions such as:

- Key issued / rotated / revoked (id and owner, not the secret)
- Grants and people changes (`GRANT_REVOKED`, `ACCESS_REVOKED_ALL`, `PRINCIPAL_RENAMED`, email added/removed)
- `AUTHZ_DENIED` (who asked for which privilege)
- `BREAK_GLASS_USED`
- An admin reading another person’s conversations (subject actor, not the text)
- Sign-in events from the login flow (`packages/control-plane/src/login.ts`)
- Spend, model routing metadata, egress host names, approval ids

The console “Immutable Ledger” view can verify the hash chain (`packages/console/src/views/LedgerView.tsx`). **viewer** and above can read the ledger (`ledger.read`).

**Limits.**

- Chat content is not supposed to be in the ledger (hashes instead). Principal and grant **snapshots** on people changes can include emails and display names. Those rows last for the WORM retention period and cannot be quietly erased.
- There is no preschool-style “audit log of who looked at this child’s file,” because there are no child files — only conversations and the AM5 admin-read row.
- Reading the ledger is a broad role privilege, not limited to a compliance officer.

---

## 11. Incident response

**Works today (technical hooks, not a playbook):**

- Fleet-wide go/stop state, set only by an admin (`fleet.state.set`).
- Isolate, pause, or reset an agent (`operator` / `admin`).
- Revoke a key, revoke all access, revoke a speak-as grant, disconnect a connection, rotate a break-glass key.
- Emergency cut of egress appears in operations/FinOps tooling for operators.

**Not possible yet** as a product feature: a guided “we think a volunteer pasted a roster / a key leaked / a child used an agent” incident wizard, automatic notification of parents, a data-inventory report for one person, or a regulator-ready timeline. Your board still needs a written incident policy (see `governance.md`). In the first hour, a factory admin should: isolate the agent, revoke keys, revoke speak-as if a client was involved, and contact the factory team to help pull ledger rows and estimate what a model vendor received. Do not try to “delete the ledger” — it is designed not to allow that.

---

## 12. Do / don’t list for staff and volunteers

**Do**

- Sign in only with your own email. Never share a dashboard login or an API key.
- Use the shortest role that works. Most volunteers should have no factory login at all.
- Treat anything you type to an agent as if you were posting it on a postcard that the vendor, a factory admin, and a future audit might see.
- Require a named human to approve any message that would leave the building (families, donors, schools, the public).
- Report a suspected leak (pasted roster, lost laptop, odd agent message) to the office admin the same day.
- Keep preschool files, allergy lists, pickup lists, SHP addresses, and background-check packets in their existing locked systems.

**Don’t**

- Don’t let children use an agent, a voice robot, or a classroom kiosk connected to the factory.
- Don’t enroll a minor in speak-as “to try it.”
- Don’t paste enrollment lists, custody notes, donor exports, or background-check results into chat “just this once.”
- Don’t type payment card numbers, bank account numbers, or Social Security numbers into an agent.
- Don’t approve a held message without reading the exact text that will be sent.
- Don’t grant **operator** or **admin** to a shared account or a short-term volunteer.
- Don’t leave when a role ends without telling an admin to run offboarding (and to revoke API keys and speak-as memberships, not only “revoke all access”).
- Don’t connect a personal Google drive, a personal inbox, or a personal giving login to a church or chapter agent.

---

## 13. Laws and standards, in plain terms

**Not legal advice.** Have counsel licensed in your state review your actual design before you collect children’s data or connect existing preschool/SHP records. Laws change; confirm the current text at the official links. This snapshot is as of 22 November 2026 (America/Phoenix).

### Children’s Online Privacy Protection Act (COPPA)

- **What it is.** A U.S. federal rule (15 U.S.C. §§ 6501–6506; 16 C.F.R. Part 312) for operators of websites or online services that are **directed to children under 13**, or that have **actual knowledge** they are collecting personal information from a child under 13.
- **Why it might matter.** If a preschool or church puts a child in front of an agent, or enrolls a child as a speak-as speaker, you are likely in “actual knowledge” territory. Collection includes prompting a child to submit information and keeping chat logs. The rule generally requires a clear notice, **verifiable parental consent** before collection/use/disclosure, a way for a parent to review and request deletion, and reasonable security. An amended COPPA Rule has a general compliance date of 22 April 2026 (90 Fed. Reg. 16918).
- **Factory status.** No parental-consent flow, no parent review/delete portal, no “this is a child” data path that stays off third-party models (**not possible yet**).
- **Sources.** [16 C.F.R. Part 312 (eCFR)](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312); FTC rulemaking and compliance date on [Federal Register / regulations.gov, FTC-2024-0003](https://www.regulations.gov/document/FTC-2024-0003-0281).

### FERPA (education records) and private preschools

- **What it is.** The Family Educational Rights and Privacy Act (20 U.S.C. § 1232g; 34 C.F.R. Part 99) protects “education records” at schools that receive funds under a U.S. Department of Education program.
- **Private and faith-based schools.** The Department of Education’s own parent and student guides state that **private and faith-based schools at the elementary and secondary levels generally do not receive such funding and are generally not subject to FERPA**. Receiving services from a public district (for example for a student placed under IDEA) does not automatically put the whole private school under FERPA; the public agency remains responsible for that student’s records.
- **What to do anyway.** Even when FERPA does not apply, parents, licensing rules, and your insurer will still expect tight control of enrollment, health, and custody information. Do not assume “we’re a church preschool, so privacy law does not apply.” COPPA, state childcare rules, and contract promises can still apply.
- **Sources.** [34 C.F.R. § 99.1](https://www.ed.gov/laws-and-policy/ferpa/); [SPPO parent guide (July 9, 2021)](https://studentprivacy.ed.gov/sites/default/files/resource_document/file/A%20parent%20guide%20to%20ferpa_508.pdf); [Eligible student guide SPPO-23-01 (March 8, 2023)](https://studentprivacy.ed.gov/sites/default/files/resource_document/file/An%20Eligible%20Student%20Guide%20to%20FERPA_0.pdf).

### State childcare licensing (preschool)

A licensed preschool must follow **the state (and sometimes city) where it operates**. Typical rules address fingerprint clearance and background checks before a staff member or volunteer starts, authorized pickup, incident logs, and how long to keep children’s and staff records. The factory does not implement those retention schedules or produce licensing binders (**not possible yet**).

**Arizona example** (many churches in this factory’s operating region; use your own state’s rules if you are elsewhere):

- Child care **facilities** are licensed by the Arizona Department of Health Services, Bureau of Child Care Licensing. Rules and statutes compilation: [bccl-facility-rules-statutes-2025.pdf](https://www.azdhs.gov/documents/licensing/childcare-facilities/rules/bccl-facility-rules-statutes-2025.pdf) (includes fingerprinting and background-check duties, e.g. R9-5-203).
- Record retention quick reference: [ADHS retention_requirements.pdf](https://www.azdhs.gov/documents/licensing/childcare-facilities/providers/forms/retention_requirements.pdf).
- Background checks: [A.R.S. § 46-811](https://www.azleg.gov/ars/46/00811.htm); fingerprint-related statutes such as [A.R.S. § 41-1964](https://www.azleg.gov/ars/41/01964.htm) (day care homes / personnel; notarized forms are confidential).

Ask your licensing specialist before any agent can see attendance, pickup, or personnel-clearance information.

### PCI DSS (donations and card payments)

- **What it is.** The Payment Card Industry Data Security Standard applies to entities that store, process, or transmit cardholder data, or that can affect the security of that environment. [PCI SSC, PCI DSS](https://www.pcisecuritystandards.org/standards/pci-dss/).
- **If you already use a giving platform** (a hosted donate form or a terminal) and never put card data into the factory, most technical PCI requirements stay with that provider, but you still have vendor-management duties. PCI SSC’s own FAQ says outsourcing does not remove the merchant’s responsibility to ensure the provider protects account data: [PCI SSC FAQ](https://www.pcisecuritystandards.org/faqs/does-pci-dss-apply-to-merchants-who-outsource-all-payment-processing-operations-and-never-store-process-or-transmit-cardholder-data/).
- **If a card number is typed into an agent**, you may have created a cardholder-data environment you are not prepared to protect. The factory has no PCI scope, no PAN filter, and no “forget this number” control (**not possible yet**).
- **Do:** keep donations on a PCI-compliant giving tool; never in chat.

### Other notes (not a complete list)

- **HIPAA** usually does not apply to a church preschool’s allergy list or to an SHP chapter the way it applies to a medical clinic. Do not use that as permission to be careless; those are still sensitive health facts about children.
- **Background checks** obtained from a consumer reporting agency can also implicate the federal Fair Credit Reporting Act. Keep that process off the factory.
- **State nonprofit and charitable-solicitation** rules may affect how donor data is used. Your chapter or denomination may have additional standards (for SHP, follow national chapter policy as well).

---

## 14. If you only remember one page

| Question | Honest answer today |
| --- | --- |
| Can we let preschoolers talk to a helpful agent? | **Not safely.** Child allowlists and no-errand rules exist, but consent, deletion, content filters, and proven identity do not. |
| Can we put allergy or pickup lists in an agent so staff can ask? | **No.** There is no special protection, and the text can go to a model vendor. |
| Can a director see what a volunteer’s agent said? | An **admin** can request another person’s conversations; it is logged. There is no lighter “director of this program only” child-records role. |
| Will the factory stop an agent from emailing a family? | **Only if** that route or skill was configured to hold, and a person approves in the console or Discord. Email approval is not built. |
| Can we delete a family’s data if they ask? | **Not as a product feature.** You can revoke access and, with the factory team, attempt a manual memory cleanup. The ledger is written to be durable. |
| Who should we call if something goes wrong? | Your factory admin first (isolate, revoke), then the factory team, then — if children’s or donor data may have left the building — your counsel and any insurer or licensing contact your policy names. |

