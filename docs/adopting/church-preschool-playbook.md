# Church and preschool playbook

A plain-language guide for a mid-sized church (about 400 people) that also runs a licensed preschool (100+ children) and wants a small virtual staff of agents on the BeerCanLabs Agent Factory.

This is a planning and how-to guide. It does not change the factory, and it is not legal, licensing, or insurance advice. Your board, your preschool licensing specialist, and your insurer still have the last word on child safety, records, and pastoral confidentiality.

**Who this is written for.** Pastors, church administrators, treasurers, elders or a board, a preschool director, and ministry coordinators. You do not need an IT department to *read* this guide or to *use* agents once they are set up. You do need the factory team to stand the factory up and to connect your church software. That is not optional today. See [What you can do without IT](#what-you-can-do-without-it) and the companion file `GAPS-church.md`.

Live reference factory (BeerCanLabs' own, not yours): the dashboard is [factory-dashboard.dalesackrider.com/ui](https://factory-dashboard.dalesackrider.com/ui), and the machine address for technical tools is `https://factory-dashboard.dalesackrider.com/mcp`. An adopting church should receive **its own** dashboard address. Do not sign church staff, volunteers, or families into someone else's factory.

---

## How to read the labels

Every capability in this guide is marked with one of three labels. They describe the factory as it exists in the `agent-factory` repository today, not a future brochure.

| Label | What it means for you |
|---|---|
| **Works today** | The factory already does this, once the factory team has given you a running dashboard and the right sign-in and permissions. A non-technical staff member can use it. |
| **Needs the factory team** | The platform can support this, but a church with no IT staff cannot set it up alone. Someone from the factory team (or a contracted implementer) must define a connection, write or adopt a skill, assign permissions, or operate the hosting. |
| **Not possible yet** | The factory does not have this, and there is no safe workaround that a church should rely on. Do not plan a ministry process around it until it is built. |

---

## What the factory is, in church terms

Think of the factory as a **guarded office building** for virtual staff, not as a single chatbot.

- The **dashboard** is the front office. Signed-in staff can talk to an agent, see what it is waiting on, approve or reject something it wants to send, watch spending, and pause an agent if it misbehaves. **Works today.**
- An **agent** is a named virtual staff member with a written job description (its "soul"), a memory style, a budget, and a tight list of tools it may use. It starts with *no* tools and *no* budget until an administrator turns those on. **Works today** (creation itself still **Needs the factory team** — there is no "Add an office assistant" button in the dashboard).
- **Approvals** are the "please initial this letter before it goes out" tray. If an agent wants to send mail, create a calendar event, or otherwise act in a person's name, the factory can hold that action until a person says yes. **Works today** in the dashboard (and in Discord). **Not possible yet** by email, text message, Slack, Microsoft Teams, or a link on your phone. See `docs/APPROVAL_ADAPTERS.md`.
- A **budget cap** is a hard stop on model spend. When an agent reaches its cap, it cannot keep going. The treasurer (or anyone given the budget-owner grant) can read spend and set caps. **Works today.**
- The **ledger** is an append-only diary of what ran, what it cost, and what was approved or refused. It is meant for audit, not for pastoral notes. **Works today.**
- **Skills** are packaged abilities an agent may be given (for example, "create a schedule" or "call this software"). The factory's default skill list is empty today (`packages/control-plane/data/skill-defaults.json`). There are no church or preschool skills on the shelf. **Needs the factory team** to add them; until then, most ministry software is **Not possible yet** to use safely.

The factory is designed so agents never hold the master passwords to your systems. Connections go through a gate, writes can be held for a person, and an operator can pause or isolate an agent. Those protections are real. They do not replace your church management system, your preschool platform, or a locked filing cabinet.

---

## What you can do without IT

A church with no IT talent **cannot** do the following itself, and should not try:

- Deploy a factory on Amazon, Google Cloud, or Azure. That work is a "landing zone" interview, cloud accounts, DNS, and sign-in configuration (`landing-zones/PATTERNS.md`). **Needs the factory team.** Attempting it yourself is a dead end.
- Share BeerCanLabs' own dashboard with your staff. One factory is one organization. There is no "Grace Church" tenant. Everyone with admin rights in a shared factory can see agents, spend, and the ledger. **Not possible yet** as self-serve multi-tenant SaaS. The workable path is a **factory of your own, hosted and operated by the factory team.**
- Connect Planning Center, Breeze, Realm, Tithe.ly, Pushpay, Brightwheel, Procare, Remind, Mailchimp, Canva, QuickBooks, or Microsoft 365 by clicking a church-friendly "Connect" catalog. Those products are not in the credential catalog (`packages/keymaster/src/catalog.ts`) and have no default skills.
- Build a new agent from the dashboard. Creating an agent is an API or a specialist builder (`POST /api/v1/agents` in `packages/control-plane/src/agent-creation.ts`; house staff in `agents/staff/agent-builder`). The dashboard has no New Agent wizard. **Needs the factory team.**

What church staff *can* do, once the factory team has hosted a factory and granted access:

- Sign in with a work Google account (if the factory team has turned Google sign-in on). **Works today.**
- Talk to the agents they have been given, in the dashboard workbench. **Works today.**
- Approve or reject a held action in the dashboard Approvals view. **Works today.**
- Ask the treasurer's view (FinOps) how much an agent has spent against its cap. **Works today** for someone with budget or admin rights.
- Pause an agent they are allowed to operate, if it is doing the wrong thing. **Works today.**

Plan adoption around that split, or it will stall in week one.

---

## Who the users are

These are the people around a typical 400-person church with a licensed preschool, and the access we recommend. "Call" means "talk to this agent and ask it to draft or look something up." It does not mean "the agent may act in this person's name without approval."

Do **not** create factory accounts for parents, guardians, or the public. The factory is a staff tool. It has no parent portal, no child-safe public chat, and no way to limit a signed-in person to "only my family's information."

| Person | What they do today | Factory access to recommend | May they call agents? |
|---|---|---|---|
| Senior / teaching pastor | Preaching, pastoral care, staff oversight | One personal dashboard account. Owner of the Pastor's Briefing agent only. Not a factory-wide admin unless the church is very small. | Yes, only their own agents. |
| Church administrator / executive pastor | Calendar, facilities, communications, office | Factory **admin** for a small staff, *or* operator plus owner of Office and Facilities agents. This is usually the day-to-day "front desk of the factory." | Yes. |
| Finance secretary / treasurer | Giving, payables, payroll handoff, board reports | **Budget-owner** grant (can read spend and set caps; cannot browse pastoral conversations). Owner of Treasurer's Clerk. Never a factory-wide admin unless they also run the office. | Yes, only the treasurer agent. |
| Board / elders | Governance, budget, policy, pastoral accountability | **Viewer** only, if they need to see spend and that the ledger exists. They approve *policy* in board meeting, not routine agent letters. | No, unless the board clerk is also the administrator. |
| Worship / music coordinator | Teams, rehearsals, service order | Member of the Volunteer Desk and Worship Draft agents only. | Yes, those agents. |
| Volunteer coordinator | Serving teams, reminders, gaps in the schedule | Member or accountable lead of Volunteer Desk. | Yes, that agent. |
| Children's ministry lead | Sunday kids programming, volunteer teams | Member of Children's Ministry Helper. Never given pickup, medical, or check-in tools. | Yes, that agent only. |
| Preschool director | Licensing, ratios, enrollment, parent communication, incidents | Accountable lead of Preschool Office Clerk. The **only** person who may approve a message that will go to preschool families. | Yes, that agent. |
| Preschool teachers | Classroom, attendance in the official app, parent notes | Optional later: member of Preschool Office Clerk with **draft-only** rights. They should keep using Brightwheel/Procare as the official record. | Drafts only, after month 1, if the director wants it. |
| Front desk / office volunteers | Phones, visitor questions, room questions | Member of Office Front Desk only. Time-limited grants are wise for seasonal volunteers. | Yes, that agent. |
| Parents and guardians | Pickup, tuition, illness, classroom questions | **No factory account.** They keep calling the office or using the preschool's official app. | **No.** |
| Children | — | Never. | **No.** |

A person who only has the factory **viewer** role can look, and can submit content, but cannot talk to an agent. Talking requires `agents.converse`, which sits on the operator role or on a grant scoped to one agent (`packages/bouncer/src/privileges.ts`). That is why we recommend **per-agent membership**, not "make every teacher an operator." An operator can also create agents and pause more of the fleet than a teacher should.

Someone who signs in with Google and has not been granted a role yet has **no** permissions (`packages/control-plane/src/login.ts` starts an OIDC session with empty roles). The factory team or the church admin must add the person and grant access. There is no self-serve "invite your volunteer" email yet. **Needs the factory team** for the first staff list; after that the church admin can add people if they have been given that right.

---

## The software you already use (and what the factory can do with it)

Keep each official system as the **system of record**. Agents may later *read* or *draft into* those systems. They must not *become* them.

| Product | Typical church / preschool use | Factory status today |
|---|---|---|
| Planning Center (Services, People, Registrations, Check-Ins) | Volunteers, service plans, event sign-ups, rooming | **Needs the factory team.** Planning Center has a public API, but there is no catalog entry, no approved "system" definition, and no skill. A church cannot click Connect. |
| Breeze ChMS | People, giving, follow-up | **Needs the factory team.** Same gap: no catalog, no skill. |
| Realm (or similar ACS/Realm suite) | People, giving, groups | **Needs the factory team.** |
| Tithe.ly or Pushpay | Online giving, pledges, statements | **Needs the factory team.** Do not let an agent send giving statements or issue refunds until a dedicated, read-mostly connection and a treasurer approval path exist. |
| Google Workspace (Gmail, Calendar, Drive, Docs, Groups) | Staff email, church calendar, bulletin drafts, shared files | **Works today** *if* the factory team has installed the factory's Google OAuth app (`google` and `google-oauth-client` in `packages/keymaster/src/catalog.ts`) and a staff member clicks Connect for the agent that should use that account. All calendar creates and outbound mail must be set to require approval. If Google still lists the factory app as "unverified," only test users can connect until the factory team finishes verification. |
| Microsoft 365 (Outlook, Calendar, Teams, OneDrive) | Same role as Workspace, in churches that standardized on Microsoft | **Needs the factory team.** Sign-in kinds built into the factory are Google, Meta, Cloudflare, and generic "single sign-on" (`IDP_KINDS` in `packages/control-plane/src/idp-config.ts`). There is no Microsoft entry in the credential catalog. Entra sign-in and Graph access can be added as a generic sign-in plus a system definition, but a church cannot do that alone. Meta sign-in is listed and then refused, because Meta does not confirm a verified email — do not plan on Facebook Login. |
| Brightwheel or Procare | Attendance, ratios, pickup authorizations, incident reports, billing, allergy and medication notes | **Needs the factory team** even to explore a read-only connection, and many official records should stay **Not possible yet** for agents. Until a locked-down, reviewable connection exists, teachers and the director use Brightwheel/Procare directly. Agents must never be the record of attendance, ratios, custody, incidents, or medical information. |
| Remind (or similar parent texting) | Classroom and school-wide texts | **Needs the factory team**, and may remain a poor fit if the vendor has no suitable API or forbids bots. Prefer: the agent drafts, a person sends in Remind. |
| Mailchimp (or similar) | Weekly email, announcements | **Needs the factory team.** Until then, the agent drafts in Google Docs or in the dashboard, and a person pastes into Mailchimp. |
| Canva | Bulletins, slides, social graphics | **Needs the factory team.** Until then, the agent drafts copy only. |
| QuickBooks (usually QuickBooks Online) | Books, bills, payroll journal, board reports | **Needs the factory team.** A read-only connection with treasurer-only access is the right first step. Writes to the books should stay **Not possible yet** for agents. |
| Slack | Some staff teams | A Slack *token* can be stored (`slack` in the credential catalog), but people **cannot** talk to an agent in Slack, and they **cannot** approve work there. **Not possible yet** as a staff channel. |
| Discord | Rare in churches | **Works today** as a chat and approval channel. We do not recommend making Discord a church's main door unless you already live there. |
| Dashboard workbench | Staff talking to agents in a browser | **Works today.** This is the channel you should train on in week 1. |

The factory *can* grow a new connection: a person proposes a "system" (where requests go, how sign-in works), an admin approves it (`systems.propose` / `systems.decide`, `POST`-style system routes under `/api/v1/systems`), and OAuth is generic once that definition exists (`packages/keymaster/src/connections.ts`, `GET /api/v1/connections/:agentId/:provider/start`). That is a factory-team job, not a church-office job.

---

## Recommended starter roster

Start small. Eight agents is a *catalog* of jobs, not a week-1 rollout. In week 1, turn on only the first three, all of them working through **Google Workspace** (or not at all, if you are a Microsoft-only office and the factory team has not connected Microsoft yet).

For every agent below:

- Memory should be **team member** for shared office work, or **personal assistant** when the agent serves one person (the pastor or the treasurer). A personal assistant keeps notebooks per person. A team member shares a team notebook. A "purpose-built" agent keeps no conversations. See `docs/architecture/agent-memory-models.md`.
- Policy should be **deny by default**: only the routes it needs, a monthly and daily budget cap, and `requireApproval` on every tool that writes (`packages/gatekeeper/src/policy/index.ts`).
- New agents start in `PENDING_BUDGET` and cannot work until a budget and policy are set (`docs/CREATING_AGENTS.md`). **Needs the factory team** (or a church admin who has already been trained on policy).
- Callers are granted as **members of that agent**, not as factory-wide operators.

### 1. Office Front Desk

- **Job.** Answer staff and volunteer questions about public information: service times, office hours, which room is booked, where the regularly scheduled meetings are, "is the building in use Saturday morning?" Draft a calendar hold or a visitor-follow-up email. It does not give pastoral advice, does not look up giving, and does not discuss a child's family situation.
- **Inputs.** A question typed in the dashboard; the church's public calendar; a shared "office FAQ" Google Doc the administrator maintains (snow policy, wedding inquiry process, building-use rules).
- **Outputs.** A spoken-in-the-dashboard answer; a *draft* calendar event; a *draft* email. Nothing goes out until a person approves it.
- **Tools.** Google Calendar and Docs. **Works today** after Connect. No Planning Center. No preschool roster.
- **Who may call it.** Church administrator, front desk volunteers, pastor. **Who approves writes.** Church administrator (or the person whose calendar would be changed).
- **Status.** **Works today** as a dashboard assistant on Google, once created and connected.

### 2. Communications Drafter

- **Job.** Draft the weekly bulletin, announcement blurbs, website blurbs, and social captions from notes the staff drop in a shared Doc or paste into the chat. It does not publish, does not send the church-wide email, and does not post to Facebook or Instagram (those outgoing posts, even later, must be held for approval).
- **Inputs.** Service order notes, upcoming events, already-approved wording (mission statement, giving links).
- **Outputs.** A draft in the dashboard or in a Google Doc. A person copies it into Mailchimp, YouTube descriptions, or the bulletin template.
- **Tools.** Google Docs / Drive. **Works today.** Mailchimp and Canva: **Needs the factory team.**
- **Who may call it.** Church administrator, communications volunteer, worship coordinator (for service-order notes). **Who approves anything that would be sent or published.** Church administrator or the communications lead the board has named.
- **Status.** **Works today** for drafts on Google.

### 3. Pastor's Briefing

- **Job.** A private Monday briefing for the pastor: this week's public calendar, already-announced events, open tasks the pastor typed in. It is not a counseling notebook and must not be used for pastoral-care notes. See [Pastoral-care confidentiality](#pastoral-care-confidentiality).
- **Inputs.** The pastor's questions; a calendar the pastor has connected; the pastor's own task list.
- **Outputs.** A private briefing in the dashboard, visible to the pastor.
- **Tools.** Google Calendar of the pastor's choosing. Memory: **personal assistant**, pastor as the only caller and owner.
- **Who may call it.** The pastor only. **Approvals.** Calendar writes, if any, held for the pastor.
- **Status.** **Works today** on Google, with tight grants.

### 4. Volunteer Desk

- **Job.** Help the volunteer and worship coordinators see gaps ("we still need two greeters at 10:30"), draft a reminder or an ask, and keep a working copy of serving teams.
- **Inputs.** Until Planning Center is connected, a Google Sheet the coordinator already maintains. After a Planning Center connection exists, *read* rosters and *draft* messages — do not let the agent be the official volunteer record.
- **Outputs.** A gap list; draft reminder text. A person sends the text (or, later, approves a send).
- **Tools.** Google Sheets/Docs **Works today.** Planning Center **Needs the factory team.**
- **Who may call it.** Volunteer coordinator, worship coordinator, church administrator. **Who approves outgoing asks.** The coordinator who owns that team.
- **Status.** Useful in month 1 on a spreadsheet; blocked from "just use Planning Center" until the factory team ships that connection.

### 5. Treasurer's Clerk

- **Job.** Answer the treasurer's questions from books or from a spreadsheet the treasurer provides: "how does year-to-date giving compare to budget," "draft the one-page board finance summary," "list bills due this week." It never sends a giving statement, never changes a donor record, never issues a refund, and never posts to the general ledger.
- **Inputs.** A treasurer-owned Google Sheet export, or later a **read-only** QuickBooks connection.
- **Outputs.** Draft reports in the dashboard or a Doc, for the treasurer to paste into a board packet.
- **Tools.** Google Sheets **Works today.** QuickBooks Online **Needs the factory team.** Writes to QuickBooks: treat as **Not possible yet** for this roster.
- **Who may call it.** Treasurer / finance secretary only. The board gets the finished PDF from the treasurer, not a factory login to this agent. **Approvals.** Any later write or donor-facing email is held for the treasurer and, for statements, should stay human-sent.
- **Status.** **Works today** on a sheet the treasurer controls; QuickBooks is a factory-team project.

### 6. Facilities and Events

- **Job.** Help schedule building use and avoid double-booking the fellowship hall. Draft a building-use reply.
- **Inputs.** The official facilities calendar (Google Calendar). A short policy Doc (fees, kitchen rules, insurance certificate required for outside groups).
- **Outputs.** Draft holds and draft replies. A person approves the calendar write.
- **Tools.** Google Calendar. **Works today.**
- **Who may call it.** Church administrator, facilities volunteer. **Approvals.** Administrator.
- **Status.** **Works today** on Google. Do not merge this calendar with preschool classroom ratios or nap rooms in a way that hides licensing constraints. Preschool room use stays on the preschool's official schedule.

### 7. Children's Ministry Helper

- **Job.** Help the children's ministry lead draft Sunday volunteer rosters, supply lists, and lesson-prep reminders from a sheet they maintain.
- **Inputs.** A coordinator-owned sheet; curriculum dates. Never a check-in kiosk, never a custody list, never allergy charts.
- **Outputs.** Draft rosters and reminder text, approved by the children's ministry lead.
- **Tools.** Google Sheets/Docs. **Works today.** Planning Center Check-Ins or Services: **Needs the factory team**, and check-in / pickup must remain human and official.
- **Who may call it.** Children's ministry lead (and a named assistant if the lead asks). **Approvals.** The lead.
- **Status.** **Works today** as a drafting helper. **Not possible yet** as a check-in or pickup system.

### 8. Preschool Office Clerk (tight box, later than the others)

- **Job.** Draft routine, non-sensitive office messages the director would have written anyway: "school is closed Monday for the holiday," "picture day is Thursday, please dress children in…," "tuition statements went out in Brightwheel today — if you did not see yours, call the office." Answer *staff* questions from a director-maintained policy Doc (hours, late pickup fees, snow days, immunization *policy* — not a child's immunization record).
- **Inputs.** The director's request; a policy Doc with no child names in it. It may **not** be fed allergy lists, custody orders, pickup PIN lists, incident reports, medication logs, or student files.
- **Outputs.** A draft message. The director (only) approves. The director or a teacher then sends it in Brightwheel/Procare or official email. The agent does not send to parents itself in the starter roster.
- **Tools.** Google Docs for policy and drafts. **Works today.** Brightwheel/Procare: **Needs the factory team**, and even then many record types should stay off-limits. Remind: draft only.
- **Who may call it.** Preschool director. Teachers only later, draft-only. Front desk may *not* use this agent to "look up who can pick up this child." **Approvals.** Director for every parent-facing draft.
- **Status.** **Works today** as a drafting assistant with a policy Doc. Official preschool operations stay in the licensed system. See [Child safety and parent data](#child-safety-and-parent-data).

### Agents we recommend you do *not* start

| Agent idea | Why not |
|---|---|
| Parent-facing chatbot, website widget, or SMS number families text | **Not possible yet** as a safe product, and a bad idea even as a workaround. Parents would need factory accounts or an unauthenticated door. There is no "only my child" boundary. |
| Counseling or pastoral-care notes agent | Confidentiality and privilege are not modeled. An administrator can ask an agent for another person's conversations (`conversations.read-others` on the admin role). See below. |
| Giving-statement or donor thank-you sender | Donor data and money. Wait for a treasurer-approved, read-mostly giving connection and a held send path in a channel the treasurer actually uses. |
| Check-in, pickup authorization, or "who can take this child" assistant | Licensing and custody. **Not possible yet** as a system of record; dangerous as a shadow list. |
| Incident-report filer | Official reports belong in the preschool's required process. An agent may, at most, remind a teacher *that* a report is due, never draft medical or allegation content into factory memory. |
| Background-check processor | Protected data; use your existing vendor and a human reviewer. |

---

## How people talk to agents, and how approval works

**Week-1 channel: the dashboard workbench. Works today.** A signed-in staff member opens the agent, types a request, and reads the reply. They can list "my conversations" and resume one. Conversations belong to the *person*, not to the phone or browser they happened to use (`docs/architecture/agent-memory-models.md`).

**Discord. Works today**, including "approve CODE / reject CODE" in a direct message. Most churches should ignore this unless they already use Discord for staff.

**Email, text message, a link in a text, Slack, Microsoft Teams, a website chat box. Not possible yet** (`docs/APPROVAL_ADAPTERS.md`; agent triggers in `packages/contract/src/schema.ts` are cron, webhook, queue, http, and Discord only).

**Technical tools (MCP, command line). Works today** for implementers, not for a preschool teacher. Do not train the office on MCP.

**Approvals, what works today.**

1. The factory holds a write (an email, a calendar create, a tool marked `requireApproval`).
2. A person who may decide it opens **Approvals** on the dashboard, reads what would be sent, and approves or rejects (`POST /api/v1/approvals/:id`).
3. Or, if you have chosen Discord, they reply there with a one-time code. The agent never sees that reply.

Train this rule out loud: *If you did not approve it, it did not go out.* If a director is at home and only has email, they cannot approve from that email today. That is a real operational gap (see `GAPS-church.md`). Until it is fixed, the director must open the dashboard in a browser, or a deputy who can open the dashboard must be named.

Held approvals expire (channel asks last a day). Configuration changes (for example, a role change) are a weaker experience in the dashboard than ordinary "send this letter" holds — the factory team should not ask a church board to decide those in the Approvals view.

---

## Child safety and parent data

This section is the preschool's non-negotiable. Put it in the board minutes. Put it in the director's procedures. Ask the factory team to configure agents so the easy path is the safe path.

### Agents are never the system of record

The official record of a child — enrollment, attendance, ratios, emergency contacts, authorized pickup, custody or restraining orders, incident and injury reports, allergy and medication information, immunizations, tuition and subsidy — lives in the licensed preschool system (Brightwheel, Procare, or your registrar's paper-and-software process) and in the files your license already requires.

Factory notebooks, uploaded Docs, chat logs, and the ledger are **not** those files. They will not satisfy a licensing specialist, and they can become a messy second copy that is harder to secure, correct, or delete.

If a staff member is about to paste a child's allergy list, a custody order, a pickup PIN, or an incident narrative into an agent chat, they should stop. Put it in the official system. Ask a person.

### What may go to an agent

- Public or staff policy: hours, snow days, tuition *policy*, picture-day logistics, the text of a holiday closure.
- Draft wording for a general announcement that names no child and no medical detail.
- A reminder *to staff* that "incident reports are due the same day," with no child details.
- Room-use on the church calendar, so long as it does not replace the preschool's ratio and attendance record.

### What must not go to an agent

- A child's full name together with a date of birth, address, or student number, unless you have a reviewed, purpose-built connection and a written data agreement — and even then, prefer that the official system stays the only copy.
- Allergy, asthma, medication, or toileting plans.
- Custody schedules, "do not release to," restraining orders, pickup PIN codes, or photo-authorization exceptions.
- Incident, injury, suspected-abuse, or behavior reports, or drafts of those reports.
- Attendance rosters used to prove ratios.
- Billing disputes, subsidy paperwork, or a parent's financial hardship notes.
- Photos or videos of children.

### Ratios, incidents, and pickup

- **Ratios and attendance.** Teachers take attendance in the official app. An agent must not be asked "are we in ratio?" unless it is reading a live official source *and* the director has accepted that product in writing. That product does not exist in the factory today. **Not possible yet.**
- **Incident reports.** The mandated form and timeline stay human. The agent may remind, not author.
- **Pickup and custody.** The front desk and the classroom check the official authorization. If the official system is down, they follow the preschool's written backup (printed authorized-pickup list in a locked office, a call to the director) — not a remembered chat with an agent. An agent that is "pretty sure Grandma is allowed" is a safety failure.

### Mandatory reporting

Nothing about an agent changes a teacher's or director's duty to report suspected abuse or neglect through the required channels. Do not ask an agent whether something is "reportable." Do not store a suspicion in an agent notebook.

### Parents

Parents keep using the official preschool app, official email, and the office phone. They do not receive factory logins. If a parent asks "the church's AI" a question, a staff member answers as a staff member.

### Licensing and data agreements

Before any later connection to Brightwheel, Procare, or a state reporting tool, the church should have, in writing: what is read, what is never read, what is never written, where copies live, how long they live, and how a parent's or regulator's deletion or inspection request is honored. The factory does not yet offer a "delete this family's data" button or a preschool retention policy. **Needs the factory team** for contractual and product work; treat a live connection as **Not possible yet** until that paper and those controls exist.

---

## Pastoral-care confidentiality

Pastoral counseling, confession, hospital notes, marriage conversations, and discipline processes are not ordinary office mail. In many states they may be protected by clergy-penitent privilege. Putting them into an agent can create a copy that a future administrator, a litigator, or a breach could see.

What is true of the factory today:

- A **personal assistant** agent keeps a notebook per person, which is the right *shape* for a private briefing. **Works today.**
- The factory does not open that notebook itself; the console asks the agent to list or show conversations. Asking about **another person's** conversations requires an **admin** and is written to the ledger (`conversations.read-others` in `packages/bouncer/src/privileges.ts`; AM5 in `docs/architecture/agent-memory-models.md`). That means a factory administrator — often the church administrator who also resets everyone's access — *can* request the pastor's private threads. That is a governance problem, not a technical comfort.
- There is no "clergy confidential" flag, no sealed notebook, no legal-hold distinct from ordinary memory, and no promise that prompt traces or backups exclude pastoral text. Prompt traces are optional and should stay **off** for a church factory.
- Conversations are rotated into closed volumes over time, not deleted (`docs/architecture/agent-memory-models.md`). There is no self-serve "forget this person" for a congregant.

**Rule for this playbook:** do not use agents for pastoral-care notes, counseling records, prayer-request details that identify a person's crisis, or staff discipline. The pastor's Briefing agent is for public calendar and the pastor's own tasks. Prayer requests that would have been printed in a bulletin are communications work, with the same consent rules you already use for the bulletin.

The board should name, in writing, who the factory administrators are, that they will not use admin rights to read pastoral conversations except under a two-person policy the board defines (for example, a misconduct investigation), and that such a read will be explained to the pastor. The ledger will show that the read happened; it may not show the words that were read.

---

## Week 1, month 1, and month 3

Times below assume the factory team has already agreed to host a dedicated factory and can work with you during this window. If that hosting is not in place, week 1 is "wait" — not "the church administrator learns Terraform."

### Week 1 — Open the office, nothing dangerous

**Goal.** A handful of staff can sign in, talk to three drafting agents on Google, approve a held calendar event once as a drill, and recite the child-data and pastoral-care rules.

1. **Factory team:** stand up the dedicated factory; turn on Google sign-in (or Entra, if that is your world and they can configure generic single sign-on); set the church's email domain so random Gmail accounts cannot join; create principals for the administrator, pastor, and treasurer; grant admin / budget-owner / pastor ownership as agreed; set a factory-wide monthly spend cap the treasurer has approved.
2. **Factory team:** create Office Front Desk, Communications Drafter, and Pastor's Briefing. Attach Google with least-possible access. Mark every write tool as requiring approval. Set small daily and monthly budgets. Use team-member memory for the office agents and personal-assistant memory for the pastor.
3. **Church administrator:** walk through sign-in, the workbench, Approvals, and "pause." Practice: "Draft a calendar hold for the Tuesday staff meeting" → see the hold → approve or reject.
4. **Treasurer:** open FinOps, confirm caps, confirm they can see spend without being made a full admin.
5. **Director and pastor:** read the child-safety and confidentiality sections with the administrator. Sign a one-page "we will not paste child or counseling records into an agent" acknowledgment.
6. **Do not:** connect Brightwheel, giving platforms, or Planning Center; add teachers or volunteers yet; add parents; turn on Discord as the public door; raise budgets "just in case."

**Success looks like.** The administrator drafted this week's announcement with Communications Drafter and copied it into the usual channel by hand. Nobody uploaded a class list.

### Month 1 — Expand the office, still drafts-first

**Goal.** Volunteer Desk, Facilities, and Treasurer's Clerk are live on Google Sheets and Calendars the church already owns. A short standing agenda reviews spend, a rejected or approved hold, and any near-miss ("we almost pasted a roster").

1. Add Volunteer Desk, Facilities and Events, and Treasurer's Clerk with the callers in the roster table.
2. If, and only if, the factory team has a reviewed Planning Center or QuickBooks **read** connection ready, pilot it with one coordinator or the treasurer — still no automated sends, still no bookkeeping writes.
3. Add two or three front-desk volunteers as members of Office Front Desk only, for a Sunday or weekday shift. Show them how to sign in. Remind them they will be signed out if the factory restarts (sessions are not kept across a restart today).
4. Ask the factory team to set the church's time zone on every schedule. The factory default is `America/Los_Angeles` (`packages/timekeeper/src/cron.ts`). If you are in Arizona (`America/Phoenix`) or anywhere else, an unset zone will fire at the wrong time, especially when daylight saving changes. One-shot "remind me tomorrow" and a schedules screen in the dashboard are still incomplete (`docs/timekeeper-roadmap.md`). Use recurring, approved jobs only, and check them.
5. Children's Ministry Helper may start as a drafting aid. Preschool Office Clerk may start as a *director-only* drafting aid with a policy Doc that has no child names.
6. Mid-month: elders or the finance committee look at spend vs. cap and at one ledger example, with the treasurer.

**Success looks like.** Sunday volunteer gaps are drafted from a sheet. The treasurer's board page is drafted from a sheet. No parent received a message that only an agent had seen.

### Month 3 — Decide what is worth connecting

**Goal.** A sober board review: what saved time, what the spend was, what scared the director, which factory-team connections are still missing, and whether to go further or stay at "smart drafts on Google."

1. Review `GAPS-church.md` with the factory team. Rank the connections you actually need (often Planning Center and QuickBooks read-only before anything preschool-related).
2. If a parent-messaging or Planning Center send path is offered, require: held approvals the director or coordinator can complete from a phone-friendly channel (email or a link — **Not possible yet** today, so do not promise it), a log of what was sent, and a named human backup.
3. Still no parent accounts, no counseling agent, no pickup agent, no incident agent.
4. Re-certify who has admin rights. Remove seasonal volunteers. Confirm the pastor still does not store care notes in the Briefing agent.
5. Write next quarter's budget cap into the treasurer's ordinary budget process.

**Success looks like.** The board can explain, in one minute, what the agents are allowed to do, what they have spent, and what they will never be asked to do.

---

## Day-in-the-life scenarios

### Monday, church administrator (works today, with the week-1 agents)

Maria opens the dashboard after staff meeting. She asks Office Front Desk whether the fellowship hall is free Thursday at 6. It reads the Google calendar and answers. She asks it to hold the room for the grief-share planning meeting. The hold appears under Approvals. She reads the event and approves it. She pastes the pastor's outline bullets into Communications Drafter and gets a bulletin announcements draft, which she copies into the usual template. She never asks the agent for a preschool allergy list sitting in her email.

### Tuesday, treasurer (works today on a sheet; QuickBooks needs the factory team)

Chris uploads nothing to the agent. He keeps a Google Sheet only he and the bookkeeper share, already used for board reports. He asks Treasurer's Clerk, "Draft the one-page summary for next week's elders meeting, using the YearToDate tab." He gets a draft, checks the numbers in the sheet, and puts the draft in the packet. He looks at FinOps and sees the office agents are well under the monthly cap. He does not grant the bookkeeper factory admin.

### Wednesday, volunteer coordinator (spreadsheet today; Planning Center later)

Jordan asks Volunteer Desk which 10:30 greeter slots are empty, based on the sheet. It lists two gaps and drafts a short ask. Jordan copies the text into a group text they already use. They do not let the agent text volunteers itself.

### Thursday, pastor (works today — and a line they must not cross)

Pastor Lee reads the Pastor's Briefing: calendar, the already-public prayer list for Sunday, a reminder to finish the newsletter paragraph. A member texts about a marriage crisis. Lee does **not** paste that thread into the agent. He uses the same pastoral notebook he used last year.

### Friday, preschool director (drafting works today; official send stays human)

Alicia asks Preschool Office Clerk to draft a holiday-closure reminder from the policy Doc. She reads it, edits one sentence, and sends it herself in Brightwheel. A teacher asks, in the hallway, whether an agent can "just check if Dad is allowed to pick up today, the app is being slow." Alicia says no: they use the official app, then the printed backup list in the locked office, then a call to her. They do not ask the agent.

### Sunday, front desk (works today, with limits)

A volunteer at the welcome desk, signed in only to Office Front Desk, is asked what time the evening service starts and whether the youth room is open. The agent answers from the public calendar. A parent of a preschooler asks whether their child is on the allergy-aware snack list. The volunteer does not type that into the agent. They walk the parent to the preschool desk, which uses the official system.

### A near-miss the factory will not save you from

A well-meaning teacher pastes a photo of a handwritten incident form into the workbench and asks the agent to "make this neater for the file." That creates a copy of a child's injury in factory memory, outside the licensed record, possibly visible later to an administrator. The right move is to stop, delete what you can, tell the director, follow the official incident process, and treat it as a policy incident — which is why week 1 includes a written acknowledgment, and why this guide says the agent must not author incident reports.

---

## Questions a church board or elders would ask

**1. Why would we do this at all?**
To give a small staff help with drafting, calendaring, and "where is that written?" questions, with a budget cap and an approval tray, without handing a volunteer a pile of API keys. It is an office aide, not a junior pastor and not a preschool teacher.

**2. Can we do this without hiring IT?**
You can *use* it without IT, if the factory team hosts a dedicated factory and sets up sign-in, agents, and connections. You cannot stand this up yourselves, and you cannot safely share someone else's factory. That hosting commitment is a prerequisite, not a nice-to-have.

**3. What will it cost?**
Two parts: (a) what you pay the factory team to host and support the factory, which you must get in a written quote, and (b) model usage, which the treasurer can cap per agent per day and per month. When a cap is hit, the agent stops; it does not keep billing in silence. Start with small caps and raise them only after month 1. This guide cannot quote a dollar figure; the treasurer should ask for a month of observed spend before the month-3 review.

**4. Who is liable if an agent emails the wrong parent or the wrong amount?**
The church remains responsible for what goes out under its name. That is why every send starts as a draft and a held approval, why parents are not talking to agents, and why giving and preschool records stay in official systems. Approval by a named person should be treated like signing a letter. Talk to your insurer about cyber and "use of AI tools" coverage; do not assume the factory vendor's terms replace that conversation.

**5. Where is our data, and who can see it?**
In a dedicated factory the factory team hosts, agent notebooks, the ledger, and connections live in that factory's cloud account and region as specified in your agreement. Ask for that in writing (where it lives, who at the vendor can access it, how backups work, what happens if you leave). Factory administrators at the church can see fleet activity and, with admin rights, can request another person's conversations. Keep the admin circle small.

**6. Can we turn it off?**
Yes. An operator or admin can pause or isolate an agent immediately (dashboard and API). Budgets also act as a kill switch when hit. Pausing does not erase memory; ask the factory team if you need a purge after you retire an agent.

**7. Will this replace staff or volunteers?**
No. The starter roster drafts and looks up. People still send the church email, take attendance, counsel members, and release children at pickup.

**8. How does this affect our preschool license?**
It should not, if you follow this guide and never treat the factory as a child record. If a later connection to Brightwheel or Procare is proposed, your licensing specialist and your contract with that vendor come first. If they cannot sign off, do not connect.

**9. What about pastoral confidentiality and elder accountability?**
Do not put care notes in an agent. If you ever revise that rule, you need a product feature the factory does not have yet (a sealed notebook an ordinary administrator cannot open) and a two-person accountability policy. Today's admin ability to request another person's conversations is the opposite of a seal.

**10. Can members or parents use it?**
Not in this design. There is no safe parent door yet. A general "ask the church AI" on the website is **Not possible yet** and would be unwise even as a novelty.

**11. What if the vendor goes away or we change clouds?**
The factory's idea is that an agent's "cartridge" is portable and the host is separate (`POSITION_PAPER.md`). That is more protection than a typical locked-in chatbot, but a church still needs an export plan in its agreement: souls, skills, and a way to retrieve documents that were only drafted in notebooks. Do not let the only copy of a board report live in an agent.

**12. How do we know it did (or did not) send something?**
For held actions, the Approvals view and the ledger record the request and the decision. For a message a person copied and sent by hand, your usual sent mail is the record — which is another reason hand-send is the right month-1 pattern.

**13. What happens on Sunday morning when something breaks?**
Use the official systems and paper backups you already have. Agents are not part of the pickup line or the giving kiosk. If the dashboard is down, Maria writes the announcement the way she did last year. Name a person who can reach the factory team, but do not invent a volunteer "IT deacon" to debug hosting.

**14. What should we ask the factory team to sign?**
A hosting agreement that includes: a dedicated factory (not shared with another customer), the region data lives in, uptime and support hours (Sunday morning matters), a spend dashboard the treasurer can read, a named way to pause everything, a written list of who at the vendor can access your factory, no use of your church or preschool content to train public models, prompt traces off, and a path to export and delete. Then a statement of work for the week-1 agents and any later connections.

**15. What are the honest holes?**
They are collected in `GAPS-church.md`. The short list: no self-serve church tenant, no shelf of church/preschool connections or templates, no email or text channel for staff to talk or approve, no child-data or clergy-confidential controls in the product, and a dashboard that still speaks in engineering terms. Those are the reasons this playbook keeps week 1 on Google drafts and human sends.

---

## A one-page rule card (print this)

1. Agents draft. People send.
2. Agents never hold the official preschool record or the official giving record.
3. No child medical, custody, pickup, attendance-ratio, or incident information in a chat.
4. No pastoral-care or counseling notes in a chat.
5. No factory accounts for parents or children.
6. If you did not approve it, it did not go out.
7. If it feels like a judgment call about a child or a vulnerable adult, find a person, not an agent.
8. If an agent misbehaves, pause it and tell the administrator.

---

## Where to go next

- Gaps that would slow or block this adoption, with severity and suggested fixes: `GAPS-church.md`.
- How agents are created (for the factory team, not the church secretary): `docs/CREATING_AGENTS.md`.
- How approvals work, and which channels exist: `docs/APPROVAL_ADAPTERS.md`.
- How memory and private conversations work: `docs/architecture/agent-memory-models.md`.
- What "the factory" is, in product terms: `README.md`, `POSITION_PAPER.md`.
