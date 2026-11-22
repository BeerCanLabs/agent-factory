# Governance for a church, preschool, or SHP chapter

**Audience:** a board, elders, or chapter officers who will say yes or no to using the Agent Factory, and the office admin who will carry out their decisions. Assumes little or no IT staff.

**Status tags** (same meaning as in `security-privacy-child-safety.md`): **works today**, **needs the factory team**, **not possible yet**. This is an operating policy pack, not legal advice. Have counsel review it before you adopt it.

The factory will not enforce these policies by itself. Several items require a human process because the product cannot do them yet. Where a control **works today**, the policy tells you who is allowed to use it.

---

## 1. Policies the board or elders should adopt

Adopt these as short, named policies (a page each is enough). Assign an owner and a review date. If you cannot staff an item, do not turn on the factory feature it is meant to govern.

1. **Purpose and scope.** What the factory is for (examples: drafting the weekly bulletin, answering office FAQ, scheduling volunteers, SHP delivery logistics among *adult* volunteers) and what it is not for (children’s records, counseling notes, background-check files, donor ledgers, unsupervised talk with minors).
2. **Acceptable use.** A written rule for staff and volunteers (sample in §2). People should sign it before they receive a login.
3. **Roles and least privilege.** Who may be an admin, who may operate agents, who is only a viewer, and that there is no shared login. Map your offices (senior pastor, preschool director, treasurer, chapter president) to factory grants (§3).
4. **Human approval of outbound messages.** No agent may send a message to a family, donor, school, recipient household, or the public until a named human has approved the exact text. Today this **needs the factory team** to put holds on every outbound route, and approval happens only in the console or Discord (**not possible yet** by email or SMS). If you cannot staff console approvals, do not allow outbound routes at all.
5. **Children and speak-as.** A standing prohibition on children using agents, on enrolling minors as speak-as members, and on placing voice clients in classrooms, nurseries, or delivery homes, until the board expressly revisits the gaps in `GAPS-security.md` and `security-privacy-child-safety.md`.
6. **Data classification and location of records.** Preschool licensing files, allergy and pickup information, SHP recipient addresses, donor data, and background-check packets stay in existing approved systems. They are not stored in agent memory and are not pasted into chats.
7. **Vendors and model use.** The board accepts that allowed AI providers will see whatever is in a prompt, and names who may change model policy and connections (factory **admin**, with the factory team). Require a subprocessor list before go-live (**needs the factory team** to produce).
8. **Access review and offboarding.** A quarterly review of people, grants, keys, and speak-as memberships (§5), and a same-day offboarding process when someone leaves (§6).
9. **Incident response.** Who is called, who may isolate an agent or pause the fleet, when counsel and (if children are involved) licensing or insurers are notified, and that the ledger must not be tampered with.
10. **Budget and spend.** A monthly cap, a **budget-owner** (often the treasurer) distinct from the day-to-day operator, and a rule that budget holds are not approved casually. (The factory’s own rule set also forbids agents from approving budget holds; keep a human in that seat.)
11. **Records and retention.** How long *your* licensing and donor records are kept (state law and SHP national policy). Do not rely on the factory to meet those schedules (`retentionDays` is not enforced; the ledger may be kept a year or more in write-once storage).
12. **Succession.** At least two human **admin** grants at all times. The factory will refuse to remove the last admin (**works today**, `409 last_admin`). The board should also record how a break-glass key is held, if the factory team has issued one.

---

## 2. Sample acceptable-use policy

Copy, add your organization’s name, and have each person with a login or a key acknowledge it.

> **Acceptable use of virtual staff (Agent Factory)**
>
> **1. Purpose.** I will use church / preschool / chapter agents only for the work my role is assigned, and only on behalf of this organization.
>
> **2. My identity.** I will sign in only as myself. I will not share my password, my session, or any API key. I will not ask an agent to act as another person except through a factory speak-as enrollment that an admin has set up for that person.
>
> **3. Children.** I will not let a child use an agent, a connected speaker, or a shared kiosk. I will not enroll a minor, and I will not type a child’s allergy, custody, pickup, counseling, or address information into a chat.
>
> **4. Sensitive records.** I will not paste or upload enrollment files, donor lists, background-check results, payment card numbers, bank accounts, or Social Security numbers. I will keep those in the systems the office has already approved.
>
> **5. What I type is not private from the operator.** Messages can be stored in the agent’s memory, sent to an AI provider, and (for admins) reviewed. I will write as if a parent, a donor, or a board member might someday be entitled to know that this was said.
>
> **6. Sending things.** I will not approve an outbound message I have not read in full. I will not ask anyone to click “approve” on my behalf. If I am not sure the recipient list or the facts are right, I will reject it.
>
> **7. Access I am given.** I will use the least access I need. If I change roles or leave, I will tell the office the same day and return any device that has a key on it.
>
> **8. Problems.** If I think a message went to the wrong person, a child used an agent, a key was exposed, or I pasted something I should not have, I will tell the office admin immediately. I will not try to hide it or to “delete the logs.”
>
> **9. Personal accounts.** I will not connect my personal email, cloud drive, social media, or giving login to an organization agent.
>
> **10. Acknowledgement.** I have read the security and child-safety guide and this policy. I understand that violation can result in loss of access and, if children or finances are involved, further action by the board.

---

## 3. Roles: owner, admin, operator, volunteer

The factory’s built-in names do not match church or chapter offices. Use this mapping. Grants are created in People & Access (**works today**, `packages/console/src/views/PeopleView.tsx`, `POST /api/v1/grants`).

| Your office | Factory grant to use | Why |
| --- | --- | --- |
| **Owner (board / elders / chapter officers as a body)** | Not a single factory role. The board holds policy; two officers hold **admin** (or one admin and a documented successor). Treasurer or finance elder holds **budget-owner**. | Legal responsibility stays with the board. Do not put the only admin grant on a contractor or on the factory vendor. |
| **Admin (office administrator, or preschool director *if* the board so names them)** | Fleet **admin** on a named person, never a shared inbox. Prefer two people. | `admin` can manage people, keys, policy, and read other people’s conversations. Treat it like access to the office safe. |
| **Operator (daily staff who will talk to agents and keep them running)** | Fleet **operator**, or an **agent-scoped** role on only the agents they need. | Operator can wake, reset, isolate, converse, schedule, and create agents. That is too much for a casual volunteer. |
| **Content reviewer (optional)** | Fleet **approver** | This only admits *drafts of agents or skills*. It does **not** approve emails or family messages. Do not assign it as “the person who checks outgoing mail.” |
| **Read-only board observer** | Fleet **viewer**, if the board truly wants them to see fleet spend and the ledger. Otherwise give them no login and a monthly written report. | Viewer can already see a lot of operational metadata. |
| **Volunteer** | **No factory grant and no API key**, unless a specific agent-scoped **member** grant is approved in writing for a named season. | There is no volunteer role (**not possible yet**). A domain-wide grant (`domain:church.org`) is too broad; do not use it for volunteers. |

**Speak-as relationships** (`owner` / `family` / `child` in `packages/bouncer/src/speak-as.ts`) are household labels for voice clients. Do not use them as a substitute for the table above. If you ever enroll a child (the board’s default should be “no”), that member must have a non-empty agent allowlist; the factory will refuse otherwise (**works today**).

**Act-as.** Admins can “Act as” another principal in the console. Use it only for support, and only for adults who have asked. It is ledgered on many mutations.

---

## 4. Approval matrix

“Decide” means a named human, recorded where the factory can record it (ledger, and an approval record when a hold exists). Items marked **not possible yet** must be done *outside* the factory or must not be done at all.

| Action | Volunteer | Operator | Admin | Board / elders | Factory status |
| --- | --- | --- | --- | --- | --- |
| Sign in and read the dashboard | No, unless a time-limited member grant | Yes | Yes | Viewer only if granted | **Works today** |
| Talk to a staff agent about non-sensitive office work | Only if granted on that agent | Yes | Yes | Rarely needed | **Works today** |
| Create or deploy an agent | No | Technically yes — policy should still require admin + board purpose sign-off | Yes | Approves the *purpose*, not the click | Create in console is limited; often **needs the factory team** (see `GAPS-core.md`) |
| Allow an agent to use a model or an external system | No | No | Yes, with holds on any write | Informed of vendors annually | Policy API **works today**; misconfiguration risk is high |
| Send or post a message to families, donors, recipients, or the public | No | Draft only | May decide a held action in the console | Sets the rule: always human-approved | Holds **work today** if configured; email/Slack adapters **not possible yet** |
| Enroll a person in speak-as | No | No | Yes (CLI/API only) | Must have forbidden child enrollment, or given a rare written exception | **Works today** via admin API/CLI; **no console** |
| Enroll a minor in speak-as or put a voice client near children | No | No | No by policy | Only after a fresh legal review and gap closure | Enforcement of child allowlists **works today**; safe classroom use **not possible yet** |
| Issue an API key for *myself* | No | If they have a login — discourage | Yes | — | **Works today** in Your API Keys |
| Issue a scoped key for another person or an agent | No | No | Yes, via signed-in `POST /api/v1/keys` | Informed if a shared device is involved | **Works today** in the API; **not** in the Keys screen |
| Grant or revoke admin | No | No | Yes, except the last admin cannot be removed | Should direct any new admin in writing | **Works today** (`last_admin`) |
| Read another person’s conversations | No | No | Only for a documented cause; it is ledgered | May commission a review | **Works today** (`conversations.read-others`) |
| Connect or disconnect a giving or email account | No | No | Yes | Treasurer informed for giving | **Works today** for connections an admin is allowed to start; card data must never enter the factory |
| Raise or approve a spending cap | No | No | With budget-owner | Budget-owner / board | **Works today** for those privileges |
| Isolate an agent or pause the fleet in an incident | No | Isolate/pause agent: yes | Fleet state: yes | Informed immediately | **Works today** |
| Offboard a departing person | Notify the office | Notify the office | Perform the checklist in §6 | If the person is an officer or the last admin | Partial **works today**; memory delete **not possible yet** |
| Accept a data-deletion request from a parent or donor | Take the request, do not promise a complete erase | Same | Start the manual process with the factory team | Counsel if children’s data is involved | **Not possible yet** as a product feature |

The factory role named **approver** is intentionally absent from the “send a message” row. It is a content-admission role, not an outbound-mail role (`packages/bouncer/src/privileges.ts`).

---

## 5. Periodic review checklist

Run this **at least quarterly**, and after any incident or staff change. An admin prepares a packet; a board officer signs that they saw it. Use People & Access, Your API Keys, the ledger, and (with the factory team) speak-as and policy exports.

**People and roles**

- [ ] Every principal is a real, current person (or a documented child/staff directory entry that cannot sign in).
- [ ] There are at least two human admins, and none is a shared mailbox.
- [ ] No volunteer holds **operator** or **admin**.
- [ ] No `domain:` grant is wider than the board intended (prefer named people).
- [ ] “Act as” is not left on by habit.

**Keys and clients**

- [ ] Every unrevoked `fk_` key has an owner, a purpose, and a last-used date that makes sense.
- [ ] Keys for departed people are revoked (not only their grants). See §6.
- [ ] No agent or service key has leftover **admin** roles unless the factory team has documented why.
- [ ] Speak-as grants: expiry dates, member lists, `targetAgents`, and `relationship` values are still right. Revoke stale grants (`DELETE /api/v1/speak-as-grants/:id`).
- [ ] No minor is enrolled. If any child relationship exists, treat it as an incident unless the board has a current written exception.

**Agents, policy, and approvals**

- [ ] Each living agent has a named human owner and a written purpose.
- [ ] Egress policy is still deny-by-default except for listed routes and hosts.
- [ ] Every route that can send a message to a person has a hold. Test one held message this quarter.
- [ ] Approval responders are still the right people, and they can actually reach the console (or Discord, if that is your only adapter).
- [ ] Model providers and subscription connections still match the board’s vendor list.

**Data and spend**

- [ ] Spot-check conversations and memories: no rosters, allergies, addresses, donor exports, or card numbers. If found, follow the incident policy.
- [ ] Budget-owner has reviewed spend and caps.
- [ ] Ledger verification has been run (console WORM check) and a screenshot or export filed with the quarterly packet.

**Policy hygiene**

- [ ] Acceptable-use acknowledgements are on file for every current login.
- [ ] This governance pack and the security guide are still the versions the board adopted (or a newer version they re-adopted).

---

## 6. Offboarding checklist

Start the day you know someone is leaving, changing roles, or losing a clearance. An **admin** performs the steps; a second person can initial the paper copy. The factory does not offer a single “offboard and erase” button.

**Same day (access)**

1. Confirm you are not removing the last human admin. If you are, grant a successor first (**works today**, `409 last_admin` otherwise).
2. In People & Access, **Revoke all access** for that principal (`POST /api/v1/principals/:id/revoke-access` with `{ "confirm": "<id>" }`). This removes grants and group memberships and ends sessions and CLI logins (**works today**). The person record stays.
3. In Your API Keys — or `GET /api/v1/keys?owner=user:…` as a signed-in admin — **revoke every remaining key**, including `mcp`, `service`, and `automation` keys. “Revoke all access” does **not** revoke long-lived keys (`packages/control-plane/src/grants-routes.ts`).
4. If they were on a speak-as grant, unenroll them or revoke the grant (`DELETE /api/v1/speak-as-grants/:id/members/:principalId` or delete the grant). There is no console screen (**needs** an admin who can use the CLI, or the factory team).
5. Disconnect any OAuth connections or personal model subscriptions that were theirs (`subscriptions.own` / admin subscription tools).
6. Collect devices, password-manager access, and any printed key material.
7. If they had Discord (or another) identity linked for approvals or chat, have an admin remove that identity link (`identity.links.set`).
8. Write a short note: who was removed, when, by whom, and which key ids / grant ids were revoked. The ledger already has rows; the note is for the personnel file.

**Within a week (data and role handover)**

9. Reassign agent ownership and approval duty so holds are not stranded.
10. Ask the factory team to help inspect that person’s conversation memories for preschool, donor, or address data and to remove what can lawfully be removed. **Not possible yet** as a self-serve export/delete. Be honest with the person if they asked for erasure: the ledger and some backups may remain.
11. Rotate any shared secret they may have seen (this should have been rare).
12. If they were a preschool staff member or an SHP volunteer, run your ordinary licensing or chapter clearance close-out *outside* the factory (badge, fingerprint file, national chapter roster).

**Do not** delete the principal record just to “make them disappear.” There is no supported people-delete that also wipes history, and you may need the id to explain old ledger rows.

---

## 7. Incident checklist (short form)

Use with §11 of `security-privacy-child-safety.md`.

1. **Contain.** Admin or operator: isolate or pause the agent. Admin: pause the fleet if more than one agent may be involved. Revoke keys and speak-as grants if a client or credential is in doubt.
2. **Do not** wipe machines or “clean the ledger” before someone has captured times, agent names, and key ids.
3. **Tell** the office admin, the board chair, and the factory team. If a child’s information, a pickup restriction, or a recipient address may have been sent out, call counsel before you notify families, and follow your licensing or SHP national incident rules.
4. **Preserve.** Export or screenshot relevant ledger rows (key events, conversation-read events, approvals).
5. **Fix and follow up.** Rotate credentials, correct policy/holds, complete offboarding if a person was the cause, and write a one-page after-action for the board within two weeks.

---

## 8. Adoption motion (sample)

> The board adopts the Agent Factory governance pack and the security, privacy, and child-safety guide dated 22 November 2026. Agents may be used only for the purposes listed in the purpose policy. Children will not use agents. Sensitive preschool, donor, background-check, and recipient-address records will not be stored in the factory. At least two human administrators and one budget-owner will be named. The office will complete the offboarding and quarterly-review checklists. The board notes the gaps in `GAPS-security.md` and will not treat those items as working features. Counsel will be consulted before any connection to preschool records or any change to the child-use prohibition.

