# Frequently asked questions

Status labels: ✅ works today · 🛠️ needs the factory team · ⛔ not yet possible ([GAPS.md](GAPS.md)).

## The basics

**What is an "agent"?**
An AI assistant with one job, a written job description, specific permissions, a budget and a real person accountable for it. See [what-is-the-factory.md](what-is-the-factory.md).

**Is this a chatbot for our website?**
⛔ Not today. There is no public website chat. Agents serve your staff and volunteers through the dashboard, AI apps that connect to the factory, or Discord.

**Will this replace our staff?**
No. It takes repetitive drafting, sorting and reminding off their plate. A person approves anything that goes to families, donors or the public.

**Do we need an IT person?**
Not to *use* it once it is set up. Today you do need the factory team to set up your factory, create agents and connect services ([getting-started.md](getting-started.md)). That is the biggest current gap ([GAPS.md](GAPS.md)).

**Can we sign up on our own?**
⛔ No self-service sign-up yet. Contact the factory team.

**Can two organizations share one factory (for example the church and the preschool)?**
A church and *its own* preschool can share one factory, using per-agent access so teachers only see preschool agents. **Separate organizations should not share** a factory: there is no wall between organizations today, so admins see everything.

## Accounts and sign-in

**How do people log in?**
With their Google account (Gmail or Google Workspace), Meta, Cloudflare, or your own single sign-on (Microsoft 365 via "Single sign-on"), whichever your factory was set up with. No separate factory password.

**A volunteer uses Yahoo/iCloud email. Can they sign in?**
⛔ Not unless they have a Google account (or your SSO). There is no email-link sign-in yet.

**Does the factory email people an invitation?**
⛔ No. Add them in People & Access, then send them the address yourself.

**Why did everyone get signed out?**
The factory was restarted or updated; sign-in sessions do not survive a restart today. Sign in again.

**We forgot who our admin is / our only admin left.**
🛠️ Contact the factory team. Always keep two admins. The factory refuses to remove the last admin.

## Agents

**How do we add an agent?**
🛠️ Fill in the agent worksheet in [getting-started.md](getting-started.md) Step 4 and send it to the factory team. ⛔ No "New agent" button yet.

**Are there ready-made agents for churches or nonprofits?**
⛔ No templates ship with the factory yet. The playbooks ([church-preschool-playbook.md](church-preschool-playbook.md), [shp-chapter-playbook.md](shp-chapter-playbook.md)) contain job descriptions you can hand to the factory team.

**Does an agent remember past conversations?**
Depends on its type. A *personal assistant* agent keeps separate memory for each person who talks to it. A *team member* agent shares memory across the team. A *purpose-built* agent remembers nothing between tasks (best for sensitive one-off jobs like sorting intake forms).

**Can an agent send email or texts on its own?**
It can only reach services an admin approved, and outgoing actions can be held for a person to approve. We strongly recommend "always approve" for anything to families, donors or the public. ⛔ Sending texts (SMS) has no built-in connector.

**Can an agent see everything in our Google Drive?**
Only what the connection allows. Connect with an organizational account that has access to just the folders the agent needs, and ask for read-only access where possible.

**Can the agent talk to kids?**
The factory has a kid-safe mode for verified child callers (built for household assistants): kid-safe tone, no agent-to-agent errands on a child's behalf. For a preschool, **agents should not talk to children at all**; they serve staff and parents. See [security-privacy-child-safety.md](security-privacy-child-safety.md).

## Money

**What does it cost?**
You pay for AI usage (per task, usually cents) plus hosting. See [costs-and-billing.md](costs-and-billing.md).

**Can we stop a runaway bill?**
✅ Yes. Every agent has per-task, per-day and per-month limits; it stops when it hits one.

**Do nonprofits get discounts?**
Depends on your AI provider; see [costs-and-billing.md](costs-and-billing.md). ⛔ The factory has no per-organization billing or nonprofit plan of its own yet.

## Safety and privacy

**Who can see what our agents do?**
Admins and viewers can see agent activity and the log. Each agent's members can use it. Agents never see passwords.

**Can we delete a family's information on request?**
⛔ Not as a single action today. Keep sensitive records in your own systems and use agents that do not keep memory for sensitive work. See [security-privacy-child-safety.md](security-privacy-child-safety.md).

**Is our data used to train AI?**
That depends on the AI provider's terms for API use (the major providers' business/API terms generally do not train on API data by default; confirm for your provider). The factory itself does not train models.

**What gets logged?**
Sign-ins, access changes, agent runs, approvals, outgoing actions and spend, in a tamper-evident ledger.

## Operations

**Something went wrong. What do we do first?**
Pause the agent (Fleet Command → Pause). Then see [operations.md](operations.md).

**How do we get help?**
🛠️ Contact the factory team directly. ⛔ No in-product help or status page yet.

**How do we remove a volunteer?**
People & Access → Revoke all access. See [operations.md](operations.md#offboarding-a-volunteer-or-staff-member--two-steps).

**What happens to our data if we stop using the factory?**
🛠️ Ask the factory team for an export of agent configurations (available today) and agent memory (depends on deployment), then for deletion. Your records in your own systems are unaffected.

## Technical (for the volunteer who "knows computers")

**Is there an API?**
Yes: REST at `/api/v1/*` (OpenAPI at `/api/v1/openapi.json`) and MCP at `/mcp`. Automated scripts should use the `/mcp` address or send a normal User-Agent; the web firewall blocks some default script user agents (error 1010) on other paths.

**Why does `whoami` say I signed in with "cloudflare-access" when I used an API key?**
A known labeling bug for API-key calls; the key is what authenticated you. ([GAPS.md](GAPS.md).)

**Is there a command-line tool?**
Yes, for macOS (`docs/CLI.md`). Most adopters never need it.
