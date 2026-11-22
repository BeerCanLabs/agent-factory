# Getting started: from "we're interested" to "our first agent is helping"

*For: the one or two people who will run the factory for your organization (church administrator, preschool director, chapter president or a trusted volunteer). No IT skills assumed.*

Status labels: ✅ works today · 🛠️ needs the factory team · ⛔ not yet possible ([GAPS.md](GAPS.md)).

---

## Step 0. Decide who is who (30 minutes, a meeting, no computer needed)

Pick these people before anything else. One person can hold more than one role in a small organization, but **two people should be able to administer** so you are never locked out.

| Your title | Factory role | What they can do |
|---|---|---|
| Executive pastor / church administrator / chapter president | **admin** (at least 2 people) | Add and remove people, change any agent, connect outside services, set budgets. |
| Preschool director, ministry leads, build-day lead | **accountable lead** for their agent(s) | Own an agent: shape its job, approve its messages, answer for it. |
| Office staff, teachers, delivery captains | **member** of specific agents | Talk to the agents they work with. Nothing else. |
| Treasurer / finance committee | **budget-owner** and **viewer** | See and set what agents cost. |
| Board / elders / chapter board | **viewer** | See agents, spend and the log. Change nothing. |
| Whoever approves outgoing messages | **approver** | Approve or reject held actions in the Approvals screen. |

Factory role names you will see in the dashboard: fleet-wide roles are *viewer, operator, approver, admin, budget-owner*; per-agent roles are *member, accountable-lead, content-owner, agent-member*. *Operator* can run and create agents but cannot manage people; most small organizations do not need it.

Also decide:

- **Which email addresses people will sign in with.** Sign-in is by Google (Gmail or Google Workspace), Meta, Cloudflare, or your organization's own single sign-on (Microsoft 365 / Entra works through "Single sign-on"). If most of your volunteers use Google, choose Google. People with Yahoo or iCloud email cannot sign in today unless they have a Google account (⛔ no email-link sign-in; [GAPS.md](GAPS.md)).
- **Who your first agent is.** Start with one, low-risk, internal job (for example "draft the weekly bulletin" or "sort bed requests into the tracking sheet"). See the playbooks for ideas.

---

## Step 1. Get a factory 🛠️

**Today there is no self-service sign-up.** The factory is not yet set up so that an organization can create its own space. You need the factory team to do one of these for you:

1. **Host a factory for you** (recommended for organizations without IT staff). The team deploys a factory, gives you its web address (for example `https://grace-church.example.org/ui`), and makes your two admins the first admins.
2. **Run it yourself** on your own cloud account (AWS, Azure, Google Cloud, or a single server with Docker Compose). This needs someone comfortable with cloud accounts, DNS and sign-in configuration. The technical instructions are in [`landing-zones/PATTERNS.md`](../../landing-zones/PATTERNS.md) and [`AGENTS.md`](../../AGENTS.md). Not recommended without IT help.

> ⚠️ **Do not share someone else's factory.** A factory today has no wall between organizations: every admin can see every agent, every log entry and every cost. Each organization should have its own factory. ([GAPS.md](GAPS.md) CORE-1.)

What to send the factory team:

- Organization name and the web address you would like.
- The sign-in method (Google is easiest) and, if you use Google Workspace or Microsoft 365, who your account administrator is. Setting up sign-in needs a "client id and secret" created in your Google or Microsoft admin console; the factory team will walk your account owner through it (🛠️ there is no setup screen for this yet; it is the `PUT /api/v1/setup/idp` call).
- Your two admins' names and sign-in emails.
- Which AI provider will pay for usage (see [costs-and-billing.md](costs-and-billing.md)).

---

## Step 2. Sign in for the first time ✅

1. Open your factory's address followed by `/ui`.
2. Choose **Sign in with Google** (or the provider your factory offers).
3. Use **exactly** the email address the factory team registered for you. A different address will sign you in with "viewer" access or none.
4. You land on the dashboard. Admins see extra menu items: *People & Access*, *Credentials & Vault*, *Identities & Access*.

Good to know:

- Sessions last up to 12 hours. **When the factory is updated or restarted, everyone is signed out** and simply signs in again (🛠️ [GAPS.md](GAPS.md) CORE-10).
- You never need a password for the factory itself; your Google/Microsoft account is your login.

---

## Step 3. Add your people ✅ (with one manual step)

In the dashboard, go to **People & Access** (admins only).

1. **Add person**: type their name and the email they will sign in with. This creates their record.
2. **Grant a role**: choose the person, a role, and either *fleet* (everything) or specific *agents*. For most volunteers: role **member**, scope **agents**, and tick only the agents they need.
3. **Tell them yourself.** ⛔ The factory does **not** send an invitation email. Send them the dashboard address and say "sign in with Google using this email". (Template below.)

Shortcut for staff with a church email domain: an admin can grant a role to a whole domain (subject `domain:gracechurch.org`), so everyone who signs in with an `@gracechurch.org` address gets, for example, *viewer*. Use this carefully; give volunteers only per-agent access.

Groups: admins can create groups (for example "Preschool teachers", "Delivery captains") and give the group roles, so you add a person to a group instead of granting roles one by one (🛠️ groups are managed through the API today; the People screen handles individual grants).

**Invitation message you can copy:**

> Hi Maria, you've been given access to our AI assistants. Go to https://grace-church.example.org/ui and choose "Sign in with Google" using maria.lopez@gracechurch.org. You'll see the Preschool Parent Desk assistant. Questions? Reply to me.

---

## Step 4. Add your first agent 🛠️

⛔ The dashboard has no "New agent" button yet. Today an agent is created one of three ways, all by the factory team or a technical volunteer:

1. **A short interview** (the easiest): you answer five questions and the factory team submits them. The factory's built-in interview asks:
   1. What should the agent be called?
   2. Is it just for you (personal) or for a team?
   3. (Team agents) Who is accountable for it?
   4. In a few sentences, what is it for and how should it behave?
   5. Which skills should it use? (optional)
   
   Your answers become a **draft**. The factory runs its security, compliance and budget checks, and an approver admits it. Nothing is live until that happens.
2. **The Agent Builder assistant** (text commands such as `set name …`, `publish`).
3. **Direct configuration** by a developer.

Write your answers in a document using this worksheet and send it to the factory team:

```
Agent name:            Preschool Parent Desk
Personal or team:      team
Accountable person:    Jane Doe (preschool director), jane@gracechurch.org
Who may talk to it:    preschool office staff (3 people), director
What it does:          Drafts replies to parent emails about enrollment, tuition dates,
                       closures and supply lists, using the parent handbook. Never gives
                       medical, custody or discipline advice; hands those to the director.
What it must never do: Send anything to a parent without the director's approval. Share one
                       family's information with another. Discuss a child by name outside staff.
Tools it needs:        Read the preschool Google Drive "Handbook" folder; draft Gmail replies.
Outside services:      Google (Drive read-only, Gmail drafts only)
Monthly budget:        $15 (per day $2, per task $0.50)
Approval before send:  Yes, always
```

A new agent starts **paused for budget** (state *PENDING_BUDGET*) until an admin or budget-owner sets its budget. It can reach **no** outside service until an admin approves each one.

---

## Step 5. Set its budget ✅

Dashboard → *Fleet Command* (or the agent's page) → **Policy / Budget**. Set:

- **Per task** (per run), **per day**, **per month** dollar limits.

When a limit is reached, the agent stops and waits; nothing is overspent. Start small (a few dollars a month for a drafting assistant). See [costs-and-billing.md](costs-and-billing.md).

---

## Step 6. Connect outside services 🛠️ / ✅

Agents use **connections** to reach Google, Slack, Notion and others. The factory holds the login; the agent never sees it.

- ✅ An admin can view connections and their status in the dashboard.
- 🛠️ Starting a new Google connection is a link an admin opens (`/api/v1/connections/<agent>/google/start`), which takes you to Google's own "Allow access" screen. There is no "Connect Google" button in the dashboard yet; the factory team sends you the link.
- ⛔ Planning Center, Brightwheel, Breeze, Realm, Procare, Microsoft 365 mail/calendar and similar church or childcare systems have no connector today.

Details for each service, and workarounds (shared Google Sheets, forwarding rules), are in [connectors-and-integrations.md](connectors-and-integrations.md).

---

## Step 7. Talk to your agent ✅

Ways to reach an agent today:

| Way | Who it suits | Status |
|---|---|---|
| **Agent Workbench** in the dashboard | Staff at a computer | ✅ |
| **Claude Desktop, ChatGPT, Cursor or another AI app** connected to the factory's MCP address (`https://<your-factory>/mcp`) | Staff who already use one of these apps | ✅ (one-time "connect" and "allow" screens) |
| **Discord** direct message | Groups already on Discord | ✅ (factory team sets up the Discord bot) |
| **Factory command line** | Technical volunteers on a Mac | ✅ |
| Email, text message, website chat, Slack, Microsoft Teams | Everyone else | ⛔ not built |

Try it: open *Agent Workbench*, pick your agent, type "Please draft this week's bulletin from these notes: …". Check the reply. If it wants to send something outside, you will see it in **Approvals** first.

---

## Step 8. Approvals ✅

Dashboard → **Approvals** lists everything waiting for a person. For a held message, it shows what will be sent; choose **Approve** or **Reject**.

- People with the **approver** or **admin** role can decide held actions.
- ⛔ There is no email or text-message approval yet; check the Approvals screen daily (or use Discord).
- ⚠️ Some agent "decisions" (where an agent asks a person a question) currently name approvers by **GitHub** username. Most churches and chapters do not have GitHub accounts; ask the factory team to route those to the dashboard instead ([GAPS.md](GAPS.md) CORE-4).

---

## Step 9. Personal API keys (most people can skip this) ✅

**Your API Keys** in the dashboard lets you create a key for yourself for a script, the command line, or an AI app that cannot use the normal sign-in screen. Types: *cli*, *mcp*, *service*, *automation*.

- ✅ You can create, rotate and revoke your **own** keys.
- 🛠️ Creating a key **for someone else or for a shared device** (for example a front-desk tablet) needs an admin and the factory team; the dashboard has no owner picker and cannot limit a key to one agent ([GAPS.md](GAPS.md) CORE-8).
- Treat a key like a password: never paste it in an email or chat.

---

## Your first-month checklist

- [ ] Two admins can sign in.
- [ ] Everyone has only the access they need (review People & Access).
- [ ] One agent is live, with a budget and an accountable person.
- [ ] Every outgoing message is approved by a person.
- [ ] Your board has approved the AI use policy ([governance.md](governance.md)).
- [ ] You know how to pause an agent ([operations.md](operations.md)).
