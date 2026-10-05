# Systems, skills and approvals: a discussion record

**Status: discussion only. This is not a plan and contains no tasks.** No person or AI agent should change code,
configuration or the console on the strength of this file. The decisions below belong to Dale, and nothing here is
decided until he writes it down. When it is decided, the result goes into `DESIGN_AUTHORITY.md` through the normal
protocol (§2), and this file gets a pointer to it.

Recorded 2026-10-05 from a conversation with Dale about the console's "Propose System Definition" form, shown with the
`discord` system. It is kept so the reasoning is not lost and so a later session cannot mistake an observation for a
request.

## What Dale said

1. **OAuth is not a choice a system owner should make.** The service requires the Keymaster no matter what. Offering
   "Static Secret", "Keymaster OAuth Connection" and "Define Keymaster OAuth Provider" as options on the form exposes
   the Keymaster's inner workings. Asked: what value does that option have?
2. **A hold belongs on the action (the skill), not on the system.** Which actions need a person's approval is a property
   of what the agent is doing, not of the service it talks to.
3. **The message limit is part of the system definition, defined by a system owner**, not a casual setting in the
   console for people who do not own the system. Having to tell the system about Discord's limit "does not feel right"
   as an ordinary form field.
4. **The approval flow is too heavy.** Every edit is a proposal followed by a separate approval.
5. **No internal codes in the console.** "TSK-067", "E9 Hold" and "K4 Strip Sign-In Links" mean nothing to the people
   who use the form. The console's text should be plain language; the codes belong in the Design Authority.

## How it works today (checked against the code, 2026-10-05)

- **A system** is a versioned record of an external service an agent reaches: upstream URL, how a credential is
  injected, optional hold rules and a link-stripping flag (`packages/contract/src/system.ts`,
  `packages/control-plane/src/systems.ts`, `DESIGN_AUTHORITY.md` §6.3.1 E10).
- **Who can change one.** `systems.propose` is held by every `viewer`; `systems.decide` (approve or reject) by an
  `admin`. A system has no owner. A proposal creates a new version with status `proposed`; the list and the form keep
  showing the active (approved) version, and the pending version appears only in the version history with an "Approve"
  button. A proposer sees nothing change, which is why an edit looks unsaved.
- **The credential choice** on the form is `None / Public`, `Static Secret (Vault)` or `Keymaster OAuth Connection`,
  plus a separate checkbox that defines an OAuth provider inside the system (admin-only, write-only).
- **Hold today** is a route-level rule on a system: a list of HTTP methods whose requests the gatekeeper-egress holds
  for a human (`hold: { methods, preview }`, `checkHold`). It applies to every request with that method on that
  system. A cartridge's skills also carry a `hold` field (for example Archie's "Required for PR merge; review and
  comments autonomous"), but it is a description checked by the triad report; nothing enforces it.
- **Where a production route comes from.** The production gatekeeper-egress starts with static routes
  `anthropic, openai, models` only. `discord`, `github`, `notion`, Google and the rest are Systems-store systems, seeded
  once from the landing-zone routes (`FACTORY_SYSTEMS_IMPORT`) and then edited as data. A static route wins over a
  system with the same id. A re-seed does not update an existing system.
- **The Discord message limit.** The gatekeeper-egress can refuse a JSON message whose `content` is over a route's
  `maxContentChars` (422 `message_too_long`; it never splits for the agent; TSK-115). The field is also part of a
  Systems definition and the console form (TSK-116), but no production system sets it yet, so nothing is refused.
  Donna and Archie split their own long replies. An unapproved proposal of 1800 for `discord` was submitted in the
  console on 2026-10-05; it changes nothing until approved.

## The security point to settle before anything moves

If a hold belongs to a skill, the gatekeeper-egress still has to enforce it, and **it cannot depend on the agent saying
which skill it is using**: a confused or manipulated agent could simply not say. Enforcement has to recognize what is
being sent (system, method, path pattern) from a declaration that the skill carries and the Factory trusts. This is
the same "which skill is this call for" question as in `docs/tinman-roadmap.md`, but a wrong answer there only picks a
different model, while here it would skip a human check.

## Open questions (all Dale's)

1. **System owner.** Who owns a system, where is that recorded, and which changes may the owner make directly: the
   message limit, the hold rules, the upstream host, the credential binding? (Compare agent owners in the Bouncer.)
2. **What still needs a second person.** Perhaps only changes that widen reach (a new upstream host, a new credential
   binding, removing a hold), while everything else is direct, versioned and ledgered with a way back. Or nothing.
3. **How a skill declares a hold.** As a method and path pattern on a named system? Who reviews a skill's declaration
   (the Registrar admits skills), and what happens to the existing route-level holds (LinkedIn's writes) during a move?
4. **Authentication kind.** If the Keymaster always owns the credential, is the system's only authentication fact
   "none, an API key, or OAuth", with the Keymaster guiding the owner through the provider setup? Where is that fact
   recorded?
5. **Where Discord's limit comes from.** Set once by the system's owner at onboarding, possibly pre-filled from a known
   template, rather than typed by whoever opens the form.
6. **The console's wording rule.** Is "no internal codes in visible text" a standing rule for the whole console (it is
   found in five labels on the Systems form today)?
7. **What happens to what is already built** (TSK-115 and TSK-116: the limit in the egress and the Systems field), once
   the above is decided.

## Related

- `DESIGN_AUTHORITY.md` §6.3.1 (E4, E7, E9, E10), §6.11 (Keymaster), §6.15 (the Cast), the Cast extraction roadmap.
- `docs/tinman-roadmap.md` (hints, owner selection and the per-skill signal).
- The Bouncer's role assignments as data (GAP-090, TSK-112) and agent owners (GAP-088).

Nothing in this file is to be executed.
