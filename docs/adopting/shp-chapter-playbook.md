# Sleep in Heavenly Peace chapter playbook

A plain-language guide for a local Sleep in Heavenly Peace (SHP) chapter that wants a small "virtual staff" of agents on the BeerCanLabs Agent Factory.

This is a planning draft. It does not change the factory, and it is not an official SHP document. National SHP rules always win if this guide and those rules disagree.

**Who this is for.** A chapter president, vice president, application manager, volunteer coordinator, build or delivery lead, fundraising lead, or treasurer. We assume the chapter is all volunteers and has no IT staff.

**How to read the labels.** Every capability below is marked as one of:

- **Works today** — the running factory already has this, once a chapter has a factory of its own and the right people are signed in.
- **Needs the factory team** — the idea fits the factory, but BeerCanLabs still has to build a connector, a skill, a template, or a hosted setup before a volunteer chapter can use it.
- **Not possible yet** — it cannot be done with what exists now, or it would break SHP's own way of working.

The live BeerCanLabs dashboard is at [https://factory-dashboard.dalesackrider.com/ui](https://factory-dashboard.dalesackrider.com/ui), with the MCP address at `https://factory-dashboard.dalesackrider.com/mcp`. That instance is BeerCanLabs' own factory, not a chapter's. A chapter should not sign into it or put family information there.

---

## 1. How a chapter actually works

Sleep in Heavenly Peace is a national nonprofit whose mission is "No kid sleeps on the floor in our town." Local chapters are volunteer-run. National headquarters handles insurance, IRS filings, and taxes. Chapter leaders are asked to focus on raising money, building beds, and delivering them. Founder Luke Mickelson has described the model as "almost like a franchise": you operate inside national boundaries, and national takes the administrative work you would not want to do. ([podcast interview with Mickelson](https://exa.ai/library/podcast/7kr6slgmd97/episode/2syg95dwvx7); [Start a New Chapter](https://shpbeds.org/blog/start-a-new-chapter-make-a-difference-in-childrens-lives/))

A typical chapter week or month looks like this.

**Bed applications.** Families, legal guardians, or a school, social-service, or other local agency apply at [shpbeds.org/apply](https://shpbeds.org/apply/). The child must be 3–17. The home must be in a ZIP code the chapter has accepted, reachable by phone, text, or email, and have room for a twin-size bed. If the chapter accepts the application, the family signs an indemnification release before delivery. Selection is by need, not first come, first served. When a chapter is out of beds or bedding, unselected applications are filed until more can be made. Not every chapter is taking applications at a given time. ([Apply for a Free Twin Bed](https://shpbeds.org/apply/))

**Chapter Portal.** Core team members manage bed requests in the SHP Chapter Portal, built on Salesforce (formerly called CX). The same portal has an inventory section for beds, mattresses, bedding-in-a-bag, sheets, pillowcases, and quilts or comforters, and a Golden Volunteers / Golden Events section for volunteer events. The portal can send system emails such as "application received," "no bed inventory," "scheduled delivery," and "application halted." ([Chapter Portal Resources](https://shpbeds.org/dashboard/chapter-portal-resources/); [Build resources](https://shpbeds.org/dashboard/build/))

**Build days.** Volunteers start with lumber (often 2-by-4s from a hardware partner such as Lowe's), work stations for sawing, drilling, sanding, assembling, staining, and branding, and leave with ready-to-deliver twin or bunk bed parts. No woodworking experience is required. Public events are listed on the chapter page; private sponsor-led builds are common for businesses and civic groups. A recent local report put the cost at about $250 per complete bed (frame, mattress, pillow, mattress cover, and bedding). Minimum age on an active build site is often 12. ([Volunteer](https://shpbeds.org/volunteer-2/); [News Herald, 18 Oct 2026](https://www.thenewsherald.com/2026/10/18/with-200-plus-children-waiting-bed-building-effort-expands-downriver/); [AZ-Phoenix chapter](https://shpbeds.org/chapter/az-phoenix/))

**Volunteer rules.** Every volunteer must fill out an indemnification release (the Build Day & Delivery Volunteer Release and Waiver of Liability). Children under 12 must be supervised by a parent or guardian at all times. Minors 12 and older must be accompanied by a legal guardian. Build-day sign-up for many chapters now runs through Golden Volunteers, which SHP adopted as its chapter event platform. ([Volunteer](https://shpbeds.org/volunteer-2/); [Delivery resources](https://shpbeds.org/dashboard/delivery/); [Golden Volunteers case study](https://goldenvolunteer.com/success-stories/sleep-in-heavenly-peace/))

**Deliveries.** Delivery day is the most sensitive work. A small, coordinated team takes the bed into the home, assembles it, adds the mattress and brand-new bedding, and often personalizes bedding from what they learned about the child. Chapter presidents coordinate who goes. Families also sign an indemnification and photo release when photos will be used. ([Volunteer](https://shpbeds.org/volunteer-2/); [Delivery resources](https://shpbeds.org/dashboard/delivery/))

**Money and reporting.** Donations are recorded in DonorPerfect. Checks are mailed to Sleep in Heavenly Peace, PO Box 2905, Phoenix, AZ 85062, with the chapter named in the memo. Cash and similar deposits use a cash deposit form and are also entered in DonorPerfect. Chapter spending is typically done on a Divvy card, not a private chapter bank account. Third-party gifts (PayPal, GoFundMe, Facebook fundraisers, and similar) must be reported to donations@shpbeds.org so the chapter gets credit. Grant and corporate-donation ideas go to the national Grants team first. After every build, the chapter president is asked to file the Chapter President's Report the same day, because those numbers feed national grants, partnerships, and weekly statistics. ([Finance dashboard](https://shpbeds.org/dashboard/finance/); [Staff dashboard](https://shpbeds.org/dashboard2/); [Point of contact](https://shpbeds.org/dashboard/poc/))

**Voice and brand.** Chapters may have Facebook and Instagram accounts (Instagram should match the Facebook username; marketing@shpbeds.org can help). Custom designs, including T-shirts, need Design Team approval and must follow the SHP Brand Book. ([Instagram FAQ](https://shpbeds.org/ufaq/can-my-chapter-add-an-instagram-account/); [Design & Marketing](https://shpbeds.org/dashboard/design/); [Media](https://shpbeds.org/media/))

That official stack — Chapter Portal, Golden Volunteers, DonorPerfect, Divvy, the SHP website, and national finance — is the chapter's system of record. An agent should help people work in those systems, not invent a second set of books, waitlists, or donation receipts.

---

## 2. People and factory roles

Give people only the access their chapter job needs. Factory roles live in `packages/auth/src/index.ts` and the privilege table in `packages/bouncer/src/privileges.ts`. The Identities / People screens describe them this way (`packages/console/src/views/IdentitiesView.tsx`):

| Chapter job | What they do with agents | Factory role to start with |
|---|---|---|
| Chapter president | Owns the chapter's factory space, approves sensitive actions, offboards people | Admin (or operator plus approver, if an admin is still held by BeerCanLabs) |
| Vice president | Covers for the president; may approve holds when the president is unavailable | Operator and approver |
| Application manager | Uses the intake and family-follow-up agents | Operator for those agents only (or an agent-scoped member / accountable-lead once grants are set) |
| Volunteer coordinator | Uses the build-day coordinator | Same, limited to that agent |
| Inventory manager | Uses the inventory tracker | Same, limited to that agent |
| Delivery manager or lead | Uses the route planner and delivery checklists | Same, limited to that agent |
| Fundraising manager | Uses thank-you and social/newsletter agents | Same, plus approver for anything that will be posted or mailed |
| Treasurer or finance lead | Uses the treasurer helper; never lets an agent move money on its own | Operator for that agent, plus approver; budget questions stay with the president |
| Ordinary build or delivery volunteer | Should not sign into the factory at all | No account |
| National SHP staff | Not factory users unless national and BeerCanLabs agree in writing | No account by default |

**Practical rules for a volunteer chapter.**

- One or two admins only (president and a backup). The factory will not let you revoke the last human admin (`packages/bouncer/src/grants.ts`).
- People who only need to say yes or no to a held message get the approver role, not admin.
- Do not hand every core team member a factory admin login "just in case."
- Delivery and build volunteers receive a printed or texted assignment from a person. They do not browse family addresses inside an agent.
- Talk to agents in the console (Workbench) today. Discord is the only other chat channel the factory can listen on. Email, SMS, Slack, Teams, and a website chat box are not built (`docs/APPROVAL_ADAPTERS.md`; gatekeeper ingress is Discord-only).

---

## 3. Starter roster of agents

Do not stand all nine up at once. Start with the low-risk writing helpers in Phase 1 of the rollout. Each card lists the job, what goes in, what comes out, which connectors it would need, who may call it, and what must wait for a person.

Connectors the factory already knows how to describe are in the Keymaster catalog (`packages/keymaster/src/catalog.ts`): Discord, GitHub, Slack (a static bot token, not a full approval channel), Notion, Google (OAuth), LinkedIn, X, plus platform OAuth clients. There is no catalog entry for Salesforce, Golden Volunteers, SignUpGenius, Facebook, Instagram, DonorPerfect, Divvy, QuickBooks, Givebutter, PayPal, Twilio, or SMS. The factory can add a new external system (`POST` a system proposal, then an admin decides it — `packages/control-plane/src/systems.ts`, `packages/registrar/src/systems.ts`), but that is work for the factory team, not a chapter volunteer.

The shipped skill catalog is empty (`packages/control-plane/data/skill-defaults.json` has `"skills": []`). The repo's only example skill is an end-to-end ping. So even for Google, someone still has to package and adopt a Gmail or Sheets skill.

Held outgoing actions (a message, a post, a write into another system) can be required in policy and will not go out until a person approves them (`docs/APPROVAL_ADAPTERS.md`, E9). Today that person approves in the console Approvals view or by a Discord reply. Email, SMS, Slack, Teams, and a one-tap link are not built.

### 3.1 Bed-request intake and triage

**Job.** Help application managers review new requests, check ZIP coverage and basic eligibility (age 3–17, reachable contact, room for a twin bed), flag urgency, and draft the next human step. It does not accept or reject a family.

**Inputs.** New applications and case status from the Chapter Portal; the chapter's accepted ZIP list; bed and bedding inventory; notes from a vetting call.

**Outputs.** A short triage list for the application managers ("these five look ready to schedule," "this one is outside our ZIPs," "this one needs a call"). Drafts of the kind of email the portal already sends, for a person to review.

**Connectors needed.** SHP Chapter Portal (Salesforce) — **not possible yet**. A temporary Google Sheet of exported rows — **needs the factory team** (Google OAuth client plus a Sheets skill). Do not make a spreadsheet the official waitlist.

**Who may call it.** Application managers and the president or vice president only.

**Approval rules.** Every change of application status, and every message to a family, waits for a person. The agent never marks a case delivered or halted on its own.

**Status.** **Not possible yet** against the official portal. A carefully limited writing assistant that only sees what a manager pastes in is **works today** once the factory team has created the agent — and even then, pasted family data stays in agent memory (see privacy).

### 3.2 Family follow-up and scheduling

**Job.** Draft and, later, send appointment texts or emails: "we would like to schedule a delivery," "please confirm the indemnification release," "we are sorry, we are out of beds and have filed your application." SHP already requires that the chapter be able to reach the family by phone, text, or email, and the portal already has "scheduled delivery" and "application halted" email templates.

**Inputs.** Accepted applications, open delivery dates, inventory of complete beds, the family's preferred contact method.

**Outputs.** Draft messages; a proposed delivery calendar; a checklist of releases still unsigned.

**Connectors needed.** SMS (Twilio or similar) — **not possible yet**. Gmail or Google Calendar — **needs the factory team**. The official portal's own email — **not possible yet** without a Salesforce connector. A printed call list for volunteers — **works today** as a draft the agent prepares from information a manager provides in the conversation.

**Who may call it.** Application managers, the delivery lead, and the president.

**Approval rules.** Every outbound family message is held (E9) for a named approver. No same-day "just send it." Never include another family's name or address in a message. Prefer the official portal templates when they exist, so families do not get two different stories.

**Status.** End-to-end texting and mailbox follow-up is **not possible yet**. Drafting a message for a person to copy is **works today**.

### 3.3 Build-day volunteer coordinator

**Job.** Help the volunteer coordinator announce a public or sponsor-led build, keep the signup count against the target (for example, 70 people to build 40 beds), remind people about waivers, safety gear, and the age rules, and produce a day-of station roster (cut, drill, sand, assemble, stain, brand, check-in).

**Inputs.** Event date, location, target bed count, signup list, waiver status, sponsor name if it is a private build.

**Outputs.** Draft event description for the chapter page; reminder messages; a station roster; a same-day headcount for the Chapter President's Report.

**Connectors needed.** Golden Volunteers / Golden Events (the platform SHP actually uses) — **not possible yet**. SignUpGenius, if a chapter still uses it locally — **not possible yet**. Chapter website events on shpbeds.org — **not possible yet**. Google Sheets or a pasted roster — **needs the factory team** for Sheets, or **works today** if the coordinator pastes the list into the chat.

**Who may call it.** Volunteer coordinator, build manager, president.

**Approval rules.** Public event posts and emails to the whole volunteer list are held for the coordinator or president. The agent may not tell a minor they can attend unaccompanied. Waiver collection stays on SHP's official form.

**Status.** A drafting and rostering helper is **works today**. A live hook into Golden Volunteers or SignUpGenius **needs the factory team** and, for Golden, likely national SHP's blessing.

### 3.4 Inventory, lumber, mattress, and bedding tracker

**Job.** Tell the inventory and build managers whether the chapter can complete N beds this Saturday: lumber, hardware, mattresses, pillows, sheets, comforters or bedding-in-a-bag. Warn when a bedding drive is needed.

**Inputs.** Counts from the Chapter Portal inventory section; build and delivery plans; incoming in-kind donations and drop-off locations listed on the chapter donate page.

**Outputs.** A "beds we can complete" number; a shopping or bedding-drive list; a flag when mattress orders or bulk lumber orders are due (national already publishes a bunk calculator, NCR tool list, and bulk lumber ordering on the staff dashboard).

**Connectors needed.** Chapter Portal inventory — **not possible yet**. A shadow spreadsheet — **needs the factory team**, and it is risky because it will drift from the official count.

**Who may call it.** Inventory manager, build manager, president.

**Approval rules.** The agent does not place vendor orders or spend on a Divvy card. It drafts a list; a person orders.

**Status.** A calculator that uses numbers a manager types in is **works today**. A live inventory agent is **not possible yet**.

### 3.5 Delivery route planner

**Job.** Help the delivery lead group homes into Saturday routes, match team size to bunk vs. twin, and prepare a per-team packet: address, parking or access notes, bed type, bedding theme if known, and the release-form checklist.

**Inputs.** Addresses and access notes from vetted applications; volunteer drivers and trucks; inventory of built beds and bedding.

**Outputs.** A proposed route list for the delivery lead to accept; a team packet the lead sends to the small delivery group.

**Connectors needed.** A maps or routing service — **not possible yet** (no such system in the catalog). SMS to the delivery team — **not possible yet**. The Chapter Portal case record — **not possible yet**.

**Who may call it.** Delivery lead and president only. Ordinary delivery volunteers do not query the agent for addresses.

**Approval rules.** Addresses, apartment numbers, gate codes, and notes about the home or family are confidential. The agent must not post a route in a public Facebook event, a group chat that includes people who are not on that team, or a newsletter. The delivery lead approves each packet before it goes to volunteers. If a volunteer drops off the team, that packet is not forwarded casually.

**Status.** A lead can sit with the agent and plan routes from a list they already have — **works today** as a conversation, with serious privacy risk if those addresses are stored in memory. An automatic router that reads the portal and texts volunteers is **not possible yet**.

### 3.6 Donor and sponsor thank-yous

**Job.** Draft thank-you notes and remind the fundraising lead to receipt gifts the official way. SHP already documents "Thank a Donor" inside DonorPerfect, including gift receipts. An agent must not invent a tax receipt or imply a gift is deductible until it is in DonorPerfect.

**Inputs.** Donor name, gift amount, date, whether it was money, a sponsored build, or in-kind bedding; sponsor logos only when already approved.

**Outputs.** Draft thank-you text (email, card, or social mention); a checklist ("enter this in DonorPerfect," "tell donations@shpbeds.org about this PayPal gift").

**Connectors needed.** DonorPerfect — **not possible yet**. Gmail — **needs the factory team**. Facebook — **not possible yet**.

**Who may call it.** Fundraising manager, treasurer, president.

**Approval rules.** Every thank-you that names a gift amount, and every public sponsor mention, is held. Never publish a donor's personal address or a child's story next to a gift without the right releases. Third-party platform gifts are flagged for national accounting, not deposited to a volunteer's personal PayPal.

**Status.** A writing helper is **works today**. Official receipting is **not possible yet**.

### 3.7 Grant and report writer

**Job.** Draft the Chapter President's Report after a build, a short impact paragraph for a local grant, or talking points for a civic-club ask. National asks that grant and corporate-donation ideas go to the Grants team first (`grants@shpbeds.org`). The agent drafts; people submit.

**Inputs.** Beds built, beds delivered, volunteer count, hours if known, ZIP coverage, waiting-list size (the "beds needed" figure on a chapter page comes from new applications and open cases). Public national stats are updated weekly from chapter numbers.

**Outputs.** A filled-in draft of the same-day president's report; a grant narrative with a sources list; a one-page sponsor-a-build estimate (beds × the chapter's current cost, often cited around $250).

**Connectors needed.** None to be useful as a writer. Official report submission and DonorPerfect chapter reports — **not possible yet**.

**Who may call it.** President, vice president, fundraising manager.

**Approval rules.** The president reviews anything that will be filed with national or a funder. The agent must not invent statistics. If a number is missing, it leaves a blank.

**Status.** **Works today** as a drafting assistant, once the agent exists. Filing the official report still happens in SHP's own tools.

### 3.8 Social media and newsletter

**Job.** Draft Facebook or Instagram posts, a short email newsletter, and event blurbs that follow the Brand Book: logo use, colors, and photos. Help announce build days, bedding drives, and volunteer needs. Do not invent a new visual identity.

**Inputs.** Approved photos, event facts, wait-list numbers the chapter is willing to publish, Brand Book guidance.

**Outputs.** Draft captions and a newsletter body, with a checklist: "Design Team approval needed if this uses a custom graphic," "photo release on file?"

**Connectors needed.** Facebook and Instagram — **not possible yet** (these are the channels chapters actually use). X and LinkedIn OAuth exist in the catalog and can hold posts for approval — **needs the factory team** to finish the factory's OAuth app, and they are the wrong primary channels for most chapters. Gmail for a newsletter — **needs the factory team**.

**Who may call it.** Fundraising or communications lead, president.

**Approval rules.** Every post is held. No photo of a child, a home, or a delivery goes out without the indemnification and photo release, and a person's review of the actual image. Custom shirts and flyers still go through SHP's Design Request / Approval form. The agent should not promise that every applicant will receive a bed.

**Status.** Drafting is **works today**. Posting to Facebook or Instagram is **not possible yet**.

### 3.9 Chapter treasurer helper

**Job.** Remind the treasurer of SHP's money path: log the gift in DonorPerfect, mail checks to the Phoenix PO Box with the chapter in the memo, fill out the cash deposit form, report PayPal or Facebook fundraiser gifts to donations@shpbeds.org, and keep Divvy receipts in order. Draft a simple monthly picture of "money in, money out, beds we can fund." It does not keep a second set of books, and it does not replace national accounting.

**Inputs.** Donation notices, Divvy receipts, mattress or lumber invoices, mileage notes if someone will request reimbursement.

**Outputs.** A to-do list, draft deposit memos, a draft note to donations@ or receipts@, a plain monthly summary for the president.

**Connectors needed.** DonorPerfect and Divvy — **not possible yet**. QuickBooks — usually the wrong tool for a chapter (national files IRS returns) and **not possible yet** as a connector. Givebutter or PayPal as a chapter's own processor — discouraged; if a gift arrives there anyway, it still has to be reported to national. Spreadsheets — **needs the factory team**.

**Who may call it.** Treasurer, president, and a designated backup only.

**Approval rules.** The agent never pays a bill, never requests a Divvy card, never files an ACH or check request, and never tells a donor their gift has been receipted until a person confirms it is in DonorPerfect. Spending stays on the Divvy policy a person already follows.

**Status.** A reminder and drafting helper is **works today**. Live bookkeeping is **not possible yet**.

---

## 4. Rollout plan

Assume the chapter has no IT staff. The chapter cannot stand the factory up itself. Deployment today is a cloud landing-zone interview (AWS, Azure, GCP, or Docker Compose), identity-provider setup, DNS, and a network matrix (`landing-zones/PATTERNS.md`, `README.md`). That is **needs the factory team** (or, honestly, it is a blocker until a hosted chapter offering exists).

**Phase 0 — Agree and set the ground rules (week 1).** The president talks with their Chapter Support lead or regional contact, and with BeerCanLabs, before any family data is involved. Written questions to settle: may the chapter use a third-party AI host at all; may it connect to the Chapter Portal, Golden Volunteers, or DonorPerfect; where may children's and families' information be stored; who pays model and hosting costs. Until that is answered, stay in Phases 1–2 with no family records.

**Phase 1 — Writing helpers only (weeks 2–3).** Factory team hosts a dedicated factory for this chapter (not Dale's dashboard). President and one backup get accounts. Factory team (or agent-builder, used by the factory team) creates the grant/report writer, the thank-you drafter, the treasurer reminder, and the social-draft agent. No Salesforce, no addresses, no photos of children. Practice approvals in the console so people know what "held" means. Set a small monthly model budget; new agents start in `PENDING_BUDGET` with no outbound access until an admin sets policy (`docs/CREATING_AGENTS.md`, `packages/control-plane/src/agent-creation.ts`).

**Phase 2 — Volunteer operations, still no family files (weeks 4–6).** Add the build-day coordinator, working from pasted or spreadsheet rosters. Collect waivers on SHP's official form only. If national agrees, the factory team can start a Golden Volunteers or chapter-page connector. Start a written offboarding drill: "what we do when a coordinator resigns."

**Phase 3 — Inventory, only if national agrees (month 2).** Prefer a read-only hook to Chapter Portal inventory. Avoid a shadow spreadsheet unless the inventory manager accepts the extra work of reconciling it after every build and delivery.

**Phase 4 — Families, deliveries, and messages (month 3 or later, and only with written national approval).** Intake triage, family follow-up, and route planning. SMS, official-portal email, and tight address handling must exist first. Turn on holds for every outbound family message. Limit who can wake those agents. Set retention and deletion rules before the first address is stored — knowing that today the factory does not enforce `retentionDays` (`docs/architecture/agent-memory-models.md`, GAP-116).

If any phase would require a volunteer to open a terminal, edit YAML, or create a Google Cloud OAuth client, stop and give that step back to the factory team.

---

## 5. Scenarios

**A family applies on a Tuesday.** Today: the portal records the application and can send "application received." An application manager later reviews it in the Chapter Portal. With Phase 4 in place: the intake agent could put a short, eligibility-checked summary on the manager's list. The manager, not the agent, decides. Status: official flow **works today** inside SHP's portal; an agent in the loop is **not possible yet**.

**The chapter is out of beds.** Today: unselected applications are filed, and the portal can send a "no bed inventory" email. An agent can draft a bedding-drive post and a president's update. It must not tell a family they will receive a bed on a date the chapter cannot meet. Drafting **works today**; sending through official templates is **not possible yet**.

**Saturday build day.** A church group sponsors 20 beds (about $5,000 at a $250 estimate). The coordinator needs sign-ups, waivers, a station plan, and a same-day president's report. The coordinator agent can draft the plan and the report. Sign-up still happens in Golden Volunteers or on the chapter page. The treasurer helper reminds someone to log the sponsorship in DonorPerfect. Drafting **works today**; live sign-up and official receipting **need the factory team** or are **not possible yet**.

**Saturday delivery.** Five homes, two bunks, three twins, one apartment with a tight stairwell. The delivery lead builds teams of people they trust. The route agent may help group the stops, but the lead approves every packet. Volunteers do not receive a raw export of the waitlist. Automatic routing and texting are **not possible yet**.

**A donor gives $250 on a Facebook fundraiser.** The treasurer helper drafts the thank-you and a note to donations@shpbeds.org. It does not print a tax receipt. Drafting **works today**; posting the thank-you to Facebook is **not possible yet**.

**A newspaper wants a photo of a child on their new bed.** The social agent can draft a caption and remind the lead to check the photo release. A person looks at the release and the photo. Nothing is posted automatically.

**The volunteer coordinator moves away.** See offboarding below. A new coordinator gets access; the old account, keys, and grants are removed the same day. Family addresses must not remain in a personal email or a phone belonging to the person who left.

**Someone asks the agent, in a public Facebook comment thread, for a family's address so they can "drop off a leftover comforter."** The agent (and any person using it) refuses. In-kind drop-off goes to the published bedding drop-off location, not to a child's home.

---

## 6. Privacy for recipient families and children

A bed application is not an ordinary customer record. It can include children's first names and ages, a home address, a phone number, and a description of sleeping arrangements (floor, sofa, shared bed, air mattress). Delivery notes may add access instructions or other details about the household. Photos from delivery day may show a child's face in their bedroom.

Treat that as confidential, similar to the care you would give a school or social-service referral.

**Rules for people.**

- Only application managers, the delivery lead, and the president or vice president see full addresses and home-situation notes.
- Build-day volunteers do not need the waitlist.
- Delivery volunteers see only the stops on their own route, after the lead approves the packet, and only for that day.
- Do not put family stories, addresses, or children's names in newsletters, Facebook groups, or sponsor slide decks without the release and a person's review.
- Do not use a personal Gmail, a personal Google Drive, or a personal phone as the lasting store of applications.

**Rules for agents.**

- Do not turn on family-facing agents until national SHP has agreed in writing, and until the factory is a chapter-only instance (not a shared factory).
- Prefer the official Chapter Portal as the system of record. If an agent must keep a copy, say so, keep it short, and delete it when the delivery is closed.
- Use the tightest memory you can. A `purpose-built` agent forgets after the run. `personal-assistant` and `team-member` agents keep notebooks, and the factory does not yet enforce retention settings (GAP-116). Shared team memory (one waitlist the whole core team can see together) is still an open design question (GAP-180).
- People with the privilege `conversations.read-others` can reopen someone else's conversation with an agent. Do not grant that casually.
- Holds are mandatory for any outbound family contact and for any social post that could identify a child or a home.
- A typed "please forget this family" request to the agent is not enough, because memory and the ledger may still hold the text. Deletion has to be a factory operation the team can actually run. Today there is no simple "delete this family's data" button (see `GAPS-shp.md` and the core gap on retention).

**Photos.** Use SHP's indemnification and photo release. If the release is not signed, the photo does not go on Facebook, Instagram, a newsletter, or a grant packet.

---

## 7. Volunteer safety

Build days are active construction sites: saws, drills, stain, and branding equipment. The official age and supervision rules are not optional, and an agent must not relax them to fill a shift.

Delivery is a visit to a private home, often with children present. SHP already treats it as a sensitive situation and keeps the team small and chosen. An agent should never recruit a last-minute volunteer from a public post and send them an address. The delivery lead remains responsible for who is on the team.

Waivers (volunteer release, family indemnification, photo release) stay on SHP's official forms. The factory has no e-signature product today.

If an agent drafts safety briefings, a build manager still reviews them against the Build Manual and current tool list on the staff dashboard.

---

## 8. All-volunteer turnover and offboarding

Chapters turn over. Application managers, coordinators, and even presidents change. Plan for that on day one.

**When you add a person.**

- Create their factory account with the least role that works.
- Link only the channels they will use (today, console sign-in; Discord only if you truly use it).
- Tell them, in writing, that family data stays in official SHP systems and must be deleted from personal inboxes when they leave.
- Do not issue a long-lived factory API key to a volunteer unless the factory team says it is required. If you do, record who has it.

**When a person leaves, or their role changes, the same day.**

1. Remove their grants and group memberships (`DELETE /api/v1/grants/:id`; People access revoke if you have it). Confirm they cannot open the console.
2. Revoke every API key they own (`DELETE /api/v1/keys/:id`). Important: revoking a person's access does not automatically revoke long-lived `fk_` keys. That is a separate step.
3. Remove identity links (Discord or anything else).
4. Rotate any shared passwords or Divvy-adjacent practices they were part of (Divvy card changes go through SHP's own card request form, not the factory).
5. Re-home agent ownership if they owned an agent. The factory can transfer content ownership; do not leave a departing volunteer as the only owner.
6. Collect physical route packets, printed waitlists, and any bedding or keys to a storage unit.
7. Ask them to delete family information from personal email, Drive, and phones.
8. Review agent notebooks and any spreadsheet the person used, and delete family records they added outside the Chapter Portal.

Practice this once before you need it. A chapter that cannot offboard a volunteer in an afternoon should not put addresses into agents.

---

## 9. What national SHP might require

This list is inferred from how SHP already asks chapters to work. It is not legal advice, and only national SHP can say yes or no.

- **Stay inside the franchise boundaries.** Insurance, tax filings, official receipts, and brand use already run through national. An agent must not create a parallel charity identity, a separate gift-receipt process, or a new logo.
- **Written permission before connecting official systems.** The Chapter Portal, Golden Volunteers, DonorPerfect, Divvy, and chapter email exist for a reason. A third-party AI host that reads or writes those systems will likely need a national review, and maybe a contract, before any chapter turns it on.
- **Written permission before storing family or child data off-platform.** Addresses, ages, household situations, and delivery photos are the most sensitive material a chapter holds.
- **Money follows official rails.** Checks to the Phoenix PO Box, DonorPerfect entries, cash deposit forms, Divvy for spending, Grants team first on grant asks, and donations@shpbeds.org for third-party platforms. An agent that "just uses Givebutter or PayPal because it is easier" can cause receipting and attribution problems.
- **Same-day Chapter President's Report** after a build, with honest numbers, because national statistics and grants depend on it.
- **Design and social rules.** Brand Book, Design Team approval for custom artwork, photo releases, and marketing@shpbeds.org for Instagram or Facebook account help.
- **Volunteer and delivery safety rules** stay as written: waivers, age limits, guardians, and small chosen delivery teams.
- **Do not promise a bed.** National already tells applicants that a bed is not guaranteed.

If national says no to agents touching applications or donations, the chapter can still use Phase 1 writing helpers on non-family work. That is useful, and it is the honest stopping point until the gaps below are closed.

---

## 10. Quick status map

| Need | Status |
|---|---|
| A hosted factory just for this chapter | Needs the factory team (blocker until it exists) |
| Sign-in and roles for the core team | Works today, once that factory exists |
| Held approvals before a message or post goes out | Works today in the console (or Discord); not by email or text |
| Pause, isolate, or retire an agent; revoke a grant or an API key | Works today, as separate steps |
| Agent-builder and configuration-only agents | Works today for the factory team; not a volunteer self-serve button |
| Google mail, calendar, or sheets | Needs the factory team (platform OAuth client, verified app, skills) |
| X or LinkedIn posting with a hold | Needs the factory team for the OAuth client; rarely what a chapter needs first |
| Chapter Portal / Salesforce | Not possible yet |
| Golden Volunteers or SignUpGenius | Not possible yet |
| SMS / phone follow-up | Not possible yet |
| Facebook or Instagram | Not possible yet |
| DonorPerfect, Divvy, official receipts | Not possible yet |
| Maps / delivery routing | Not possible yet |
| E-sign for waivers and releases | Not possible yet |
| Enforced deletion and retention of family data | Not possible yet |
| Email, SMS, or Slack as the place you talk to an agent or approve its work | Not possible yet |

The detailed gap list, with severity and suggested fixes, is in `GAPS-shp.md`.

---

## Sources

- [Apply for a Free Twin Bed](https://shpbeds.org/apply/)
- [Volunteer with SHP](https://shpbeds.org/volunteer-2/)
- [Start a New Chapter](https://shpbeds.org/blog/start-a-new-chapter-make-a-difference-in-childrens-lives/)
- [AZ-Phoenix chapter leadership and events](https://shpbeds.org/chapter/az-phoenix/)
- [DE-Kent Co chapter leadership](https://shpbeds.org/chapter/de-kent-co/)
- [Chapter Portal resources](https://shpbeds.org/dashboard/chapter-portal-resources/)
- [Build resources, including Chapter Portal and president handbook](https://shpbeds.org/dashboard/build/)
- [Delivery resources, including vetting, photo release, and volunteer waiver](https://shpbeds.org/dashboard/delivery/)
- [Finance: DonorPerfect, Divvy, deposits, Giving Program](https://shpbeds.org/dashboard/finance/)
- [Staff dashboard, including Chapter President's Report and design approval](https://shpbeds.org/dashboard2/)
- [Staff dashboard home, including DonorPerfect training and fundraising](https://shpbeds.org/dashboard/)
- [Point of contact for donations, grants, insurance](https://shpbeds.org/dashboard/poc/)
- [Design & Marketing and Brand Book](https://shpbeds.org/dashboard/design/)
- [Media / Brand Book](https://shpbeds.org/media/)
- [Can my Chapter add an Instagram account?](https://shpbeds.org/ufaq/can-my-chapter-add-an-instagram-account/)
- [Golden Volunteers case study on SHP](https://goldenvolunteer.com/success-stories/sleep-in-heavenly-peace/)
- [News Herald, 18 Oct 2026, on chapter expansion, intake, and ~$250 bed cost](https://www.thenewsherald.com/2026/10/18/with-200-plus-children-waiting-bed-building-effort-expands-downriver/)
- Mickelson on chapter model, ZIP routing, need-based selection, and national handling of insurance and IRS filings: [podcast interview](https://exa.ai/library/podcast/7kr6slgmd97/episode/2syg95dwvx7)

Factory evidence cited in place: `README.md`, `docs/CREATING_AGENTS.md`, `docs/APPROVAL_ADAPTERS.md`, `docs/architecture/agent-memory-models.md`, `landing-zones/PATTERNS.md`, `packages/keymaster/src/catalog.ts`, `packages/bouncer/src/privileges.ts`, `packages/bouncer/src/grants.ts`, `packages/auth/src/index.ts`, `packages/console/src/views/IdentitiesView.tsx`, `packages/control-plane/src/systems.ts`, `packages/control-plane/src/keys-routes.ts`, `packages/control-plane/src/grants-routes.ts`, `packages/control-plane/src/agent-creation.ts`, `packages/control-plane/data/skill-defaults.json`, `packages/timekeeper/README.md`.
