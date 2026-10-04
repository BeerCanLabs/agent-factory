# Executor prompt: Bouncer flow, the moves (TSK-094 to TSK-102)

Execute the behavior-preserving part of the Bouncer extraction in BeerCanLabs/agent-factory. The plan is in `DESIGN_AUTHORITY.md`; this file only tells you how to work it.

## Read first, on an up-to-date `main`
1. `CLAUDE.md`.
2. `DESIGN_AUTHORITY.md` §2 (the protocol), §6.15 (the Cast extraction roadmap and decisions) and the "Bouncer flow work stream" block in §5: intent, what Dale confirmed, the gate, the traps and the privilege census.
3. Rows TSK-094 to TSK-102 and GAP-086 and GAP-087 in the §4 and §5 tables.

The Treasurer flow (PRs #77 and #79) is the worked example.

## Rules
- Never push to `main`. Never use `--no-verify`. Never weaken or skip a check; no `.skip`.
- Work on branch `feat/bouncer-flow`, created from `main` in your own clone or worktree. Run `npm install` once per clone.
- Take the lowest task that is `PENDING` and whose "after" tasks are `COMPLETED`. One task at a time, in order.
- For each task follow §2: cite the invariants that apply; set the row to `LOCKED` with your name, date and the lock; edit only files in that lock (to touch another file, expand the lock in `DESIGN_AUTHORITY.md` first); when done, set it to `COMPLETED` with resolution notes and release the lock.
- One commit per task, subject `refactor(bouncer): <what> (TSK-0xx)`, with the Co-Authored-By and session lines your session specifies.
- Each task must be green on its own. Run, in order: `npm test`; `npm run validate`; `./scripts/conformance.sh`; and for tasks that add a dependency edge (094, 095, 096, 098) both image builds or `./scripts/compose-e2e.sh`.
- These are moves: no behavior changes. Do not edit assertions in `held.test.ts`, `held.e2e.test.ts`, `index.test.ts`, `access.e2e.test.ts`, `keymaster.test.ts`, `keymaster.e2e.test.ts`, `routes.test.ts` or `gatekeeper-egress.test.ts`; import lines are fine.
- Strict order, no parallel work: 095, 096 and 097 edit the same egress file; 095, 096, 099 and 101 edit `app.ts`.
- Every new dependency edge needs all five places: the package's `package.json`, the root build list, `scripts/conformance.sh`, both Dockerfiles (builder `-w`, runtime `COPY package.json`, runtime `COPY` of `dist`) and `package-lock.json`.
- Cartridge or agent behavior is not Factory code (the Donna Test). Add no interface beyond API, webhooks, WebSockets and events.

## If the plan is wrong
Stop. Do not improvise around it. Tell Dale which task, which line, and what the code actually shows. A task that needs a file outside its lock, or a check weakened, is a plan error: it gets fixed in a docs PR, not worked around.

## Pull request
After TSK-102, push `feat/bouncer-flow` and open one PR against `main`: "refactor(bouncer): extract the Bouncer, moves only (TSK-094 to TSK-102)", with a summary, one line per task and a test plan. Do not start TSK-103 or later; Dale must confirm their defaults first. Archie reviews: answer every comment, fixing it if the claim is right and replying with evidence if it is wrong.

The PR touches `DESIGN_AUTHORITY.md` and (TSK-095) `scripts/conformance.sh`, which are CODEOWNERS paths: it needs Dale's review and Dale merges it.

## Report when done
The PR link, which tasks are `COMPLETED`, and anything surprising.
