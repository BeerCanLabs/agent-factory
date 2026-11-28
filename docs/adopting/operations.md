# Day-to-day operations

*For: your factory admins and each agent's accountable person.*

Status labels: ✅ works today · 🛠️ needs the factory team · ⛔ not yet possible ([GAPS.md](GAPS.md)).

---

## Daily (5 minutes)

- **Approvals** screen: approve or reject anything waiting. Held items do not go out until someone decides. Channel questions (Discord) expire after a day.
- Skim each agent's recent replies in **Agent Workbench** for anything odd (wrong tone, wrong facts, private information where it shouldn't be).

## Weekly (15 minutes)

- **FinOps & Pricing**: check spend per agent against its budget. An agent that stopped because it hit a limit shows as over budget; raise the limit only if the work was legitimate.
- **Triage & Incidents**: anything listed here means an agent failed or was stopped. Read the message; most are "over budget", "not allowed to reach that service", or "connection expired".
- **People & Access**: remove anyone who has stopped volunteering (see Offboarding).

## Monthly / quarterly

- Review each agent's job description with its accountable person. Is it still needed? Is it still accurate?
- Review **Credentials & Vault**: are all connections still in use? Disconnect any that are not.
- Review the **Immutable Ledger** for unusual activity (sign-ins at odd hours, access changes you did not make). Your board or a viewer can do this.
- Quarterly: rotate any API keys used by scripts or shared devices (below).

---

## When something goes wrong

### "The agent said something wrong or inappropriate"

1. **Pause it** ✅: Fleet Command → the agent → **Pause**. A paused agent takes no new work.
2. If it may have sent something, check **Approvals** history and the **Ledger** for what went out and to whom.
3. Tell the accountable person and, if a family or donor was affected, follow your incident policy ([governance.md](governance.md)).
4. Fix the job description (🛠️ the factory team edits the agent's configuration; every change is versioned and can be rolled back).
5. **Resume** ✅ when fixed.

### "The agent is stuck or not answering"

- Check **Triage & Incidents** and the agent's status in **Fleet Command**.
- Common causes and fixes:

| What you see | Likely cause | Fix |
|---|---|---|
| Over budget / PENDING_BUDGET | Budget limit hit or never set | Raise or set the budget (FinOps / agent policy) ✅ |
| "egress denied" / not allowed | Agent tried a service it isn't approved for | Admin approves the service in *Systems & Egress* if it should be allowed ✅ |
| Connection expired / needs re-auth | The Google (or other) permission lapsed or the person who connected it left | Reconnect 🛠️ (factory team sends the connect link) |
| Everyone was signed out | The factory was updated or restarted | Just sign in again ✅ |
| Error 1010 from a script | The web firewall blocked an automated tool | Ask the factory team; use the `/mcp` address or a normal browser ✅ |

- **Reset** ✅ (Fleet Command) clears a stuck agent's current state. **Isolate** ✅ cuts it off from all outside services immediately. Use Isolate if you suspect it is leaking information.

### "The whole factory is down"

- Open the factory address in a browser. A sign-in page, or a refusal that says unauthorized, means the factory process answered and the problem is the front door. A browser error that never reaches a page can mean it is down.
- 🛠️ If it is down, or nobody can sign in, contact the factory team. They follow the [lockout recovery runbook](../runbooks/lockout-recovery.md) (AWS console access; it restores an admin grant and does not hand out a recovery key). ⛔ There is no public status page or in-product support contact yet ([GAPS.md](GAPS.md)). Agree a support contact and response time with the factory team when you start.

### Emergency stop

An admin can pause agents one at a time from Fleet Command (or Isolate one to cut off its outside access instantly). 🛠️ The factory also has a fleet-wide kill switch for outgoing traffic, operated by the factory team. ⛔ There is no single "pause everything" button for adopters.

---

## Offboarding a volunteer or staff member ✅ (two steps)

1. **People & Access** → find the person → **Revoke all access**. This removes all their roles and group memberships, signs them out everywhere and cancels their command-line logins. It is logged.
2. **Their API keys stay** (they have no power without roles, but clean them up): 🛠️ ask the factory team to revoke the person's keys, or have the person revoke them in *Your API Keys* before they leave.

Also:

- **Agents they owned**: give each agent a new accountable person *before* revoking (🛠️ agent owners are changed by an admin through the factory team today).
- **Connections they made**: if they connected their own Google account to an agent, that connection stops working when their account is removed from your Google Workspace. Reconnect using an organizational account (best practice: always connect with a shared organizational account such as `office@`, never a personal one).
- If they used their **personal** email to sign in, removing them from your Google Workspace does nothing; step 1 is what removes factory access.
- The person's record stays (so the log still makes sense) and can be re-granted if they return.

## Onboarding someone new

See [getting-started.md](getting-started.md) Step 3. Give the least access that lets them do their job; most volunteers need *member* on one or two agents.

---

## API keys: rotating and revoking ✅

Keys are for scripts, the command line and AI apps that cannot sign in normally.

- **Your API Keys** → **Rotate** gives a new secret and retires the old one. Update the script or app right away.
- Rotate keys **quarterly**, when someone who knew a key leaves, or immediately if a key may have been seen (pasted in an email, shared screen, left on a printout).
- 🛠️ Keys for shared devices or for another person can only be created or rotated by an admin through the factory team.
- Never send a key by email, text or chat. If you must hand one over, use a password manager share.

---

## Backups and recovery

What the factory keeps for you:

- ✅ **Agent configurations are versioned.** Every change to an agent's job, owners or settings is a new version; earlier versions can be restored. An admin can download every agent's full history (`/api/v1/config/export`; 🛠️ no dashboard button yet).
- ✅ **The ledger** (the activity log) is tamper-evident and, on cloud deployments, copied to locked storage for a retention period (365 days by default).
- 🛠️ **Agent memory** (what an agent has learned and its notes) is stored in the factory's storage bucket. Backups and retention of that storage depend on how the factory was deployed; ask the factory team what they back up and for how long.
- Removed agents are recoverable for a period before they are purged.
- ⛔ There is no "Download backup / Restore" button, and no way to export or delete one family's or donor's data on request ([GAPS.md](GAPS.md)).

What **you** should keep outside the factory:

- Your source-of-truth records stay in your own systems (church management system, preschool enrollment system, the SHP national portal, your Google Drive). Agents should **read from and write drafts to** those systems, not become the only copy.
- A copy of each agent's job description (the worksheet you sent the factory team).

---

## Changing an agent

- ✅ Budget, pause/resume, reset, isolate: dashboard.
- ✅ Who may use it (member roles): People & Access.
- 🛠️ Its job description, skills and allowed services: send the change to the factory team. Every change is versioned; some elevated changes (new permissions, roles) require an owner's or admin's approval before they apply.

## Retiring an agent

Pause it first, wait a week to make sure nobody needs it, then ask the factory team to retire it. Retired agents are kept for a period before being purged.
