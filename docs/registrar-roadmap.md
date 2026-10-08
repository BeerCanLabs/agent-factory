# Registrar roadmap: new versions are offered, and a person deploys them from the factory

Status: **intent confirmed, gaps recorded, not started.** The extraction of the Registrar into its own package is planned
separately (`DESIGN_AUTHORITY.md` §6.15, roadmap step 4, the Registrar flow work stream, TSK-124 to TSK-132) and is moves
only. This file records the version flow that belongs to the Registrar and is not part of that extraction, so the work can
be planned when the extraction is done. Owner of the intent: Dale (chat, 2026-10-07). It is for any person or AI agent
picking the work up; it is self-contained, and everything in it that describes the code can be checked against the paths
named below.

## Intent

**Deploying an agent is a factory action, and a new version of an agent is something the factory tells a person about.**

- A deploy is run by an admin or by the agent's owner, through the factory (the API, from the console, and later from the
  gaming UX, Garrison). It is never a CI workflow outside the factory.
- A new commit on a registered agent's repository raises an **alert**. It is not admitted automatically. An admin decides
  to admit it; admission (L3) runs on that action. When the admission is green the agent shows **"new version
  available"**, and the admin or the agent's owner deploys it (L4).

```
new commit seen  ──alert──▶  admin admits  ──▶  admitted (green)  ──▶  "new version available"  ──▶  admin or owner deploys
                                           └──▶  refused (reason shown)
```

This amends L5 (`DESIGN_AUTHORITY.md` §6.8): L5 said the factory runs every new commit through admission by itself. The
decision (Dale, chat, 2026-10-07) is that it alerts, and an admin chooses to admit.

## What happens today (checked 2026-10-07)

1. **The source is pinned once.** `POST /api/v1/registry/agents` takes a repository and either an exact commit or resolves
   the repository's HEAD once with `gitLsRemoteResolver` (`packages/control-plane/src/app.ts`, the registration route).
   Nothing looks at the repository again.
2. **Admission is part of the deploy call.** `POST /api/v1/registry/agents/:id/deploy` (privilege `registry.deploy`) may
   re-pin the record to another exact commit, runs admission (`admission.status` goes `building`, then `admitted` or
   `refused`, on the agent record, `packages/registrar/src/catalog.ts`), and deploys an admitted commit as an image tagged
   by its SHA. There is no way to admit without deploying.
3. **Only an admin can deploy.** `registry.deploy` is held by the `admin` role alone (the `admin` entry of `ROLE_PRIVILEGES` in
   `packages/bouncer/src/privileges.ts`); the derived `agent-owner` role (`DERIVED_ROLE_PRIVILEGES`) holds wake, pause,
   resume, config, credentials and connections on its own agent, and not deploy. The console's Deploy button (`packages/console/src/views/FleetView.tsx`) shows only for an agent in
   `PENDING_DEPLOY`, and is enabled only for `admin` (`usePermissions.canDeploy`). A deployed agent has no way to be
   deployed at a newer commit from the console.
4. **No "new version available".** The agent record has no field for an offered commit, nothing alerts, and L5 is
   `unchecked` in the coverage table (GAP-051). SK5 says the same for skills ("skill update available") and is not built
   either.
5. **Agents are deployed by a GitHub Action in the operations repository** (`BeerCanLabs/submind-aws`; Dale, chat,
   2026-10-07). That repository is not part of this one and is not described here. It is the path this work retires, and
   because it is the operations repository (`CLAUDE.md` rule 1) the change there is separate and comes after the factory
   flow exists.

## Gaps

### 1. A new commit on a registered repository is never noticed
The factory resolves a repository's HEAD once, at registration. A person finds out there is a newer version only by going
to the repository. Wanted: an alert that names the agent, the commit and when it was seen.

### 2. Admitting and deploying are one action
Admission runs only inside the deploy call. Wanted: an **admit** action an admin runs on a seen commit (its result, green
or refused with the reason, shown on the agent), and a **deploy** action that deploys an admitted commit. The existing
deploy route keeps working for a first deploy.

### 3. The agent's owner cannot deploy
Every agent can name its owners (GAP-088), and an owner can wake, pause and resume the agent, but only an admin can deploy
it. Wanted: the owner deploys an admitted version of their own agent (a Bouncer privilege grant on the derived role, so
the role table changes in code, as it does for every other owner right).

### 4. The console has nowhere to show or act on a new version
Wanted: a "new version available" mark on the agent (and in Garrison when it is built), the commit, its admission result,
and the actions the viewer is allowed (the admin: admit and deploy; the owner: deploy). The console follows the privilege,
not the role name, and owns no logic (the headless principle, §6.5).

### 5. Deploys can come from outside the factory
A workflow in the operations repository deploys agents. Wanted: none. The factory is the only place a deploy is run, and
the factory ledgers who did it (E3). Retire the workflow in `submind-aws` once gaps 1 to 4 are in place.

## Order of work

1. Finish the extraction (TSK-124 to TSK-132). The admission contract (`admit`, TSK-129) is written so that it can be
   called without deploying, because admitting a seen commit is the same function with a different caller.
2. Decide, with Dale, the open questions below.
3. Then build in this order: (a) split admit from deploy in the API (no new behavior beyond the split); (b) the owner may
   deploy an admitted version of their own agent, and the console's `canDeploy` follows the privilege; (c) the offered
   commit on the agent record, the check that notices a new commit, and the alert; (d) the console: "new version
   available", admit, deploy; (e) retire the workflow in `submind-aws`.

Plan each part in the shape of the Treasurer, Bouncer and Timekeeper extractions: small tasks, each green on its own,
decisions written as "Confirmed by Dale" before anything is handed to an executor, and the plan checked against the code by
someone other than its author. TSK-028 is the umbrella task for this work.

## Open questions for Dale

1. **How is a new commit noticed?** A periodic check by the Timekeeper (every N minutes, plus a "check now" action), a
   push webhook from the repository host through the ingress, or both. The check is cheap (`git ls-remote`); the cost of an
   admission (a build) is only paid when an admin admits.
2. **Who is alerted, and where?** The admin only, or the agent's owner too; the console, and a channel (Discord).
3. **May an owner admit, or only an admin?** The decision so far is that an admin admits and an admin or the owner deploys.
4. **A newer commit arrives while one is offered or being admitted.** Replace the offer with the newest, or keep a list.
5. **Does L5's policy clause stay?** L5 let a person set a policy so that an agent's admitted versions deploy without a
   click. It is kept as written for now and is not part of the first build.

## Constraints that stay

- This is Factory code (what is offered, admitted and deployed, and who may do it), not an agent's behavior; the Donna
  Test does not apply.
- Nothing is loaded at runtime (SK4): a deploy builds one image from the pinned source at its admitted commit, tagged by
  its SHA (L4). The Registrar decides what is admitted; the Landlord builds and runs it.
- A route asks the Bouncer for one named privilege and never names a role (§6.15, Bouncer). Admit and deploy are named
  privileges in the contract.
- Every admit and deploy is ledgered with who did it (E3).
- No new interface beyond API, webhooks, WebSockets and events (`KPF.md`).
