# What the Agent Factory is (and what it can do for you)

*For: pastors, church administrators, preschool directors, nonprofit chapter leaders, volunteer coordinators, board members. No technical background assumed.*

> **Status labels used in every adoption guide**
> - ✅ **Works today**: you can do this now in the dashboard or by talking to an agent.
> - 🛠️ **Needs the factory team**: possible today, but someone technical (the factory team) has to do a step for you.
> - ⛔ **Not yet possible**: the factory cannot do this yet. See [GAPS.md](GAPS.md).

## The short version

The Agent Factory is a place where AI "staff members" (we call them **agents**) live and work for your organization. Each agent has:

- **A job description** (its "soul"): who it is, what it does, how it talks, what it must never do.
- **Skills**: the specific things it is allowed to do, such as read a calendar, draft an email, or update a spreadsheet.
- **Permissions**: which outside services it may reach and which people may talk to it.
- **A budget**: how much it may spend on AI usage per task, per day and per month.
- **A manager**: a real person who is accountable for it (the factory calls this the agent's *owner* or *accountable lead*).

Think of the factory as the **office building** and each agent as an **employee** with a badge. The building decides which doors the badge opens, keeps a permanent sign-in log of everything that happens, holds anything risky at the front desk until a person approves it, and stops anyone who goes over budget.

## What agents can realistically do for a church, preschool or volunteer nonprofit

Good fits (repetitive, text-heavy, rule-based work):

- Draft replies to routine emails and messages ("What time is Sunday service?", "Is there space in the 3s class?").
- Turn notes into a weekly newsletter or bulletin draft for a person to approve.
- Keep a volunteer schedule straight and remind people of their shifts.
- Write donor thank-you notes from a donation list, for a person to review and send.
- Sort incoming requests (prayer requests, bed requests, enrollment inquiries) into a tracking sheet.
- Summarize a month of activity for the board or a grant report.
- Check a list against a rule ("Does every classroom have enough adults on Tuesday's schedule?") and flag problems to a person.

Poor fits (keep a human in charge):

- Anything that decides about a child's safety, a custody question, discipline or medical care.
- Pastoral counseling or crisis response. Agents should hand these to a person immediately.
- Money movement (refunds, payments, payroll).
- Final decisions about who receives help (bed recipients, scholarships).

## How the pieces fit (plain language)

| Piece | What it means for you | Where you see it |
|---|---|---|
| **Dashboard** (the "console") | The website where you manage people, agents, approvals and spend. | `https://<your-factory>/ui` (Dale's factory: `https://factory-dashboard.dalesackrider.com/ui`) |
| **Agents** | Your AI staff. | Dashboard → *Fleet Command* and *Agent Workbench* |
| **People & Access** | Who can sign in and what they may do. | Dashboard → *People & Access* (admins only) |
| **Approvals** | Things an agent wants to do that need a person's OK first. | Dashboard → *Approvals* |
| **Spend** | What AI usage costs, per agent. | Dashboard → *FinOps & Pricing* |
| **Ledger** | A permanent, tamper-evident log of every important action. | Dashboard → *Immutable Ledger* |
| **Connections** | Links to outside services (Google, Slack, etc.) that agents use, without the agent ever seeing your password. | Dashboard → *Credentials & Vault* (admins) |

## What the factory protects you from (built in today) ✅

- **Agents never see passwords or tokens.** The factory holds them and hands an agent short-lived access only during a task.
- **Agents can only reach approved outside services.** A new agent can reach nothing until an admin allows it (its "egress" starts empty).
- **Risky actions can be held for a person.** An outgoing request can be held until someone approves it in the dashboard (or, today, by Discord reply).
- **Spending caps.** Each agent can have a per-task, per-day and per-month dollar limit; when it hits one, it stops.
- **Pause and kill switch.** An admin can pause, isolate or reset any agent from the dashboard.
- **Everything is logged** in the ledger, which cannot be quietly edited.
- **The factory knows who is talking.** Each request carries a verified identity. Agents can be told to treat children differently (kid-safe mode for verified child callers exists today for household assistants; see [security-privacy-child-safety.md](security-privacy-child-safety.md)).

## What you should know up front (honest limits) ⚠️

- 🛠️ **Today the factory is run by the factory team, not by you.** There is no "sign up your organization" button. Each organization needs the factory team to set up a factory (or a space on one) for it. See [GAPS.md](GAPS.md) CORE-1 and CORE-2.
- 🛠️ **Creating a new agent is not a dashboard button yet.** The factory team (or a technical volunteer) creates agents from a short interview you fill in. See [getting-started.md](getting-started.md).
- ⛔ **People cannot yet text, email or web-chat an agent directly.** Today people reach agents through the dashboard's Agent Workbench, through AI apps like Claude Desktop or ChatGPT that connect to the factory, or through Discord.
- ⛔ **Approving by email or text message is not built.** Approvals happen in the dashboard (or by Discord direct-message reply).
- AI makes mistakes. Every agent that writes to people outside your staff should have a person approve its messages, at least at first.

## Where to go next

- [Getting started](getting-started.md): from "we're interested" to "our first agent is helping".
- [Church + preschool playbook](church-preschool-playbook.md) and [Sleep in Heavenly Peace chapter playbook](shp-chapter-playbook.md): concrete agent rosters.
- [Costs and billing](costs-and-billing.md), [Security, privacy and child safety](security-privacy-child-safety.md), [Governance](governance.md).
- [Day-to-day operations](operations.md) and [FAQ](faq.md).
- [Known gaps](GAPS.md): what makes adoption hard or blocked today.
