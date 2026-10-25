# Rules of engagement: building the skill package plan

Status: **frozen once merged.** Nobody amends this file after it merges. If a rule cannot be followed, the actor stops,
says which rule and why, and waits for Dale. Only Dale can supersede it, with a new document.

Scope: executing `docs/skill-packages-plan.md` (the plan) from first PR to production, by three actors in separate
sessions. Each actor can be started fresh from this file (see "Start prompts").

## Actors

| Role | Name | Runs as | GitHub identity | Does | Never does |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Builder | **Switch** | Gemini | `switch` | Reviews the plan, writes the solution, opens PRs, answers reviews, reviews results PRs | Merges, deploys, touches `submind-aws`, edits this file |
| Reviewer and merger | **Archie** | Claude, acting as Dale | `Archie-Engineer` | Reviews PRs through subagents, approves and merges, decides deploy gates, files pin PRs, answers on results | Writes the solution, reviews directly, deploys, approves a change to a human-aligned decision |
| Operations | **Grok** | Grok, acting for Dale | `dsackr` (Dale's account) | Approves and merges pin PRs, deploys, tests in production, decides on a rollback, files results PRs | Changes code, merges anything else, decides what gets built |

Credentials: Archie's token is the AWS Secrets Manager secret `factory/prod/ARCHIE_GITHUB_TOKEN` (us-east-1). It
belongs to the GitHub user `Archie-Engineer`. Archie reads it through `scripts/bcl-aws`, first confirms that it resolves
to `Archie-Engineer`, never prints it, never writes it to a file or a commit. Nobody bypasses a hook, a classifier
or a branch check, and nobody force-pushes `main`.

## Working on one machine

All three actors run on the same computer, so they must not share a working tree or an identity.

- **One clone each, under `~/repos/BeerCanLabs/`.** An actor creates its clone at start if it is missing, and never
  uses Dale's own checkouts (`agent-factory`, `submind-aws`) or another actor's clone.
  - Switch: `agent-factory-switch`
  - Archie: `agent-factory-archie` (its subagents may use temporary clones) and `submind-aws-archie` (pin PRs)
  - Grok: `agent-factory-ops` (results PRs) and `submind-aws-ops`
- **Install and build inside your own clone** (`npm ci`, `npm run build`): the repository's hooks run the conformance
  tests there and fail without them. Nobody bypasses a hook.
- **Identity is per command, never global.** The GitHub CLI's saved login on this machine is Dale's, and Grok uses it.
  Archie and Switch use their own tokens by setting `GH_TOKEN` for each command only. Nobody runs `gh auth login` or
  `gh auth switch`, edits global git configuration, or writes a token to a file. Set `user.name` and `user.email` in
  your own clone only. Each actor starts by confirming whose identity its commands resolve to (`gh api user --jq .login`
  returns `switch`, `Archie-Engineer`, or `dsackr`).

## Kickoff

Before the loop starts, Dale merges this file. That is the only approval needed before starting. Then:

1. Switch reads the plan, reviews it, and adjusts agent-decided items it sees fit under "The source of truth".
2. Switch opens slice 1 (the Design Authority amendments) as its first PR. If Switch adjusted the plan, that PR comes
   first and is reviewed like any other.
3. **Switch brings slice 1 to Dale in its own session**: the PR link, then each amendment in plain words (what the
   recorded decision said, what it becomes, which decision of Dale's causes it), then one question: "Approve slice 1?"
4. Dale approves in either of two ways: approving the PR on GitHub, or telling Archie in Archie's session to approve
   slice 1. In the second case Archie posts Dale's words in a comment on the PR, verbatim, and then approves and merges.
5. The loop starts when slice 1 is merged. Slice 1 is the only PR that waits for Dale.

## The source of truth

The plan decides what to build. Its labels apply here unchanged:

- **Human-aligned (H1 to H12)** cannot be changed by any actor. A PR that conflicts with one is blocked and goes to
  Dale as an open question. Any doubt whether it conflicts is treated as a conflict.
- **Agent-decided (A1 to A27)** can be changed by Switch only with a committee record: three fresh reviewer agents,
  started by Switch's session and not by the proposing agent, each given the decision, its rationale and the proposed
  change; passes at two of three with no High finding standing; the votes and reasons go in the plan's decision log in
  the same PR. Archie checks the record and checks that the change does not conflict with an H decision.
- **Design Authority amendments** (plan slice 1) change recorded decisions and are human-gated: Dale approves that PR
  himself. Archie does not approve it, and does not count that wait as a send-back.

Switch's first job is to review the plan and adjust agent-decided items it sees fit, under the rule above. Those
adjustments are PRs like any other.

## The loop

1. Switch opens a PR. One concern per PR, from a branch off `main`. The description names the slice and the decision IDs
   it implements and says how it was tested. It follows `CLAUDE.md` and the Design Authority protocol.
2. Archie reviews it (next section), then approves and merges it, or sends it back.
3. If the merged PR is a **deploy gate** (below), Archie holds further approvals and merges until the gate closes.
4. Operations runs, then the results PR is reviewed (below).
5. Repeat until the loop ends.

The loop ends when Dale stops it, or when **done**: every slice of the plan is merged, the final deploy has passed, a
results PR shows the end-to-end check passing in production with a skill registered by uploading a package, repository
registration is removed, and `docs/SKILLS.md` is rewritten. Archie then posts a completion note on the last PR and
stops.

## Reviewing a PR (Archie)

**Archie never reviews a PR directly.** For each review round Archie starts a fresh subagent to review, reads what it
returned, decides, and only then submits the review on GitHub. A review round may use up to two subagent runs: the
first reviews; the second, if needed, is a fresh agent that tries to confirm or refute the first's blocking findings.
Archie decides after reading both and does not forward a finding it has not checked against the code.

What blocks:

- a conflict with an H decision or a Design Authority invariant;
- a bug, a security problem, or a missing or weak test for new behavior;
- scope outside the PR's slice, or a mismatch with the plan;
- a failing required check (`test`, `compose-proof`).

Wording, style and LOW findings do not block. Archie lists them as follow-ups and approves.

Outcomes:

- **No blockers or bugs:** approve, then merge (squash) when the required checks have passed. Protection is not
  changed: GitHub does not enforce Archie's approval, so this is a process rule. Archie uses `gh pr merge`, not the
  auto-merge feature.
- **Blockers or bugs:** submit the review as "request changes" and wait. That is one send-back.
- **Third send-back of the same PR:** the review tells Switch to rethink its approach, withdraw (close) the PR, and start
  fresh with a new PR. A replacement PR starts its count at zero. If a replacement for the same slice is also sent back
  three times, Archie records an open question for Dale and stops approving that slice.
- **Human-gated** (an H conflict or a Design Authority change): Archie blocks, records an open question, and does not
  count it as a send-back.

## Deploy gates (Archie decides)

After merging, Archie decides whether the PR must be deployed and tested in production before more work is approved.
Default: gate if the PR changes behavior in a production path (control plane, runtime, builders, Gatekeepers, landing
zones, registry or access control); do not gate docs-only or test-only PRs. Archie can override the default and records
the reason on the PR.

While a gate is open Switch may keep opening PRs and pushing. Archie reviews them but does not approve or merge until
the gate closes.

## Pin PR, deploy and results (Archie, Grok, Switch)

1. **Archie files the pin PR** against `submind-aws` (Archie does not merge it), moving the `upstream/agent-factory` pin to the merged commit, then
   waits for the results.
2. **Grok approves the pin PR with auto-merge** after checking that the SHA is the merged commit on agent-factory
   `main` and that `scripts/check.sh` passes. Where the repository does not offer auto-merge, Grok merges it with `gh`
   once the checks pass. Grok then follows `submind-aws/OPERATIONS.md` and runs `deploy-aws`, watches it to the end, and
   runs the production tests the gating PR needs (including `config-agent-e2e` where the plan calls for it). Grok
   records the previous pin before it starts.
3. **Grok decides whether to roll back, and rolls back only when the factory in AWS is non-functional.** Non-functional
   means a platform check in the deploy fails (a service is not on the pinned SHA or unhealthy, the control plane or a
   Gatekeeper does not answer, the echo or llm-summarizer run does not complete, a service crashes, or the ledger does
   not verify), or an existing agent can no longer run. Then Grok repins to the previous known-good pin, merges that,
   runs `deploy-aws`, and confirms the checks pass, before doing anything else. A failed production test of the new
   behavior, or a bug Grok finds, is **not** a reason to roll back while the factory still works: Grok files it in
   the results PR and the loop forward-fixes. Grok writes its reasoning for rolling back, or for not rolling back, in
   the results PR.
4. **Grok files a results PR** in agent-factory, adding one file under `docs/engagement/results/` named for the pin.
   It states the pin and previous pin, the run IDs and links, each check's result, the production tests and their
   output, any rollback taken, and what Grok observed. It states facts only and proposes no code.
5. **Switch reviews the results PR** and submits a review saying what action the results require: none, a fix, or a
   different approach.
6. **Archie answers once**, as a review with feedback. If they still disagree, Archie records an open question for Dale
   and goes no further. Switch may proceed on the points where they agree.
7. **Archie merges the results PR.** The gate closes when a passing results PR is merged. A failed deploy or failed production
   test keeps the gate open until a fix PR is merged and a later results PR passes.

## Open questions

An open question is a GitHub issue in agent-factory labeled `open-question`, opened by Archie. It states the question,
the positions, the PR, and what is blocked and what is not. Only Dale closes one. Work that does not depend on it
continues.

## Stopping and limits

- Only Dale stops the loop. No actor ends it on its own except at **done**.
- If an actor hits a usage limit, it pauses, and resumes from its last state when the limit resets. The others keep
  going where they can. There is no extra spend cap.
- An actor that cannot follow a rule stops and tells Dale (see the top).

## Start prompts

Dale merges this file first. Each actor then starts in a fresh session with its own prompt.

- **Switch:** "You are Switch, the Builder. Read `docs/engagement-rules.md` and `docs/skill-packages-plan.md` on `main`
  of BeerCanLabs/agent-factory, and act only as the Builder. Work in `~/repos/BeerCanLabs/agent-factory-switch` (clone
  it if missing, install and build there). Use your own GitHub identity `switch`; confirm it first. Start with the
  Kickoff section: review the plan, then open slice 1 and bring it to me for approval."
- **Archie:** "You are Archie, the reviewer and merger. Read `docs/engagement-rules.md` and `docs/skill-packages-plan.md`
  on `main` of BeerCanLabs/agent-factory, and act only as Archie. Your GitHub token is the Secrets Manager secret
  `factory/prod/ARCHIE_GITHUB_TOKEN` for the user `Archie-Engineer`, read through `scripts/bcl-aws`; set it as
  `GH_TOKEN` per command and confirm it resolves to `Archie-Engineer` before anything else. Work in
  `~/repos/BeerCanLabs/agent-factory-archie`. Review every PR Switch opens, following the rules exactly, and run until
  I stop you or the plan is done."
- **Grok:** "You are Grok, Operations, acting for me. Read `docs/engagement-rules.md` on `main` of
  BeerCanLabs/agent-factory and `OPERATIONS.md` in BeerCanLabs/submind-aws, and act only as Operations. Use the saved
  GitHub login (`dsackr`); confirm it first. Work in `~/repos/BeerCanLabs/agent-factory-ops` and
  `~/repos/BeerCanLabs/submind-aws-ops`. Wait for Archie's pin PRs, then deploy, test, roll back only if the factory
  is non-functional, and file results PRs, following the rules exactly."
