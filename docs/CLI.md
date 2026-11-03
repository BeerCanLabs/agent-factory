# The Factory CLI

`factory` is a terminal client for a factory instance (DESIGN_AUTHORITY.md §6.17). You point it at your factory, sign in as yourself, and talk to the **Factory Manager**. The manager answers questions about cost, agents, budgets, approvals and runs, and can make changes. It can also connect you to an agent so you talk to that agent directly.

It is a client of the factory's existing API (KPF): it adds no interface and no logic the web console lacks.

## Install (macOS)

```
brew install cloudflared          # the identity-aware proxy's own client
npm install && npm run build -w @beercanlabs/factory-auth -w @beercanlabs/factory-ledger -w @beercanlabs/factory-bouncer -w @beercanlabs/factory-cli
npm link -w @beercanlabs/factory-cli   # puts `factory` on your PATH
factory
```

`factory` opens with a splash screen even when nothing is set up. It shows the factory it points at, who is signed in, and what to type next. Set up from inside it:

| Command | |
|---|---|
| `/config` | walks the settings (Enter keeps each one); or set one directly: `/config address <url>`, `/config theme <auto\|dark\|light\|mono>`, `/config manager <agent>`, `/config auth <auto\|cloudflare-access\|oidc>` (normally found by `/login`) |
| `/login` | signs you in. Signed in already, it offers to sign you out or sign in as a different user |
| `/connect <agent>` | talk to an agent directly |
| `/manager` | back to the Factory Manager |
| `/whoami`, `/help`, `/exit` | |

`/login` signs you in by whatever the factory uses (see "How people sign in" below). The credential is kept in the macOS Keychain and renewed when it can be. The CLI never holds a `FACTORY_TOKEN` and sends no identity of its own; the factory verifies what it is sent (A2). Signing out removes the Keychain item, and for Cloudflare Access also the copy `cloudflared` keeps in `~/.cloudflared`. If the browser signs you straight back in as the same person when you switch users, sign out of your identity provider in the browser first (OIDC asks the provider to authenticate again).

Settings live in `~/.config/factory-cli/config.json` (readable by you only) and are never sent to the factory or the manager. Changing the factory address signs you out of the old one. The theme is `auto` and `dark` for dark terminals, `light` for light ones, `mono` for no colour; colour is also off when `NO_COLOR` is set or output is not a terminal.

Shortcuts for scripts: `factory login --url <address>`, `factory logout`, `factory whoami`, `factory config get`, and `factory config set <address|auth|theme|manager> <value>` (the ops repository's installer uses the last one). `FACTORY_URL` overrides the saved address, `FACTORY_MANAGER_AGENT` or `--manager <id>` the manager, and `FACTORY_CLI_ACCESS_TOKEN` supplies an Access assertion directly (for example from `cloudflared access token`) when you cannot use the browser flow.

## Use

```
$ factory
  ┏━╸┏━┓┏━╸╺┳╸┏━┓┏━┓╻ ╻
  ┣╸ ┣━┫┃   ┃ ┃ ┃┣┳┛┗┳┛
  ╹  ╹ ╹┗━╸ ╹ ┗━┛╹┗╸ ╹
  Agent Factory CLI 0.1.0

  Factory   not set
  Signed in no
  Manager   factory-manager

  Start: /config to set your factory address, then /login to sign in.

factory> /config address agent-factory.example.com
factory> /login
manager> what have we spent this month?
> get_spend_report {"period":"current"}
So far this month: $212.40 (AI $171.10, infrastructure $41.30), 71% of the $300 total budget.
manager> set donna to $5 a day
The manager wants to run: set_agent_budget {"id":"donna","spendLimitUsd":5,"period":"daily"}
This changes the factory. Allow it? [y/N] y
Donna's budget is now $5 a day.
manager> let me talk to donna
Connected to donna. /manager to go back.
donna> good morning
```

## Commands (no manager needed)

Everything the Factory Manager can read or do, you can also ask for directly. The manager is optional; commands work with none admitted, with one that is over budget, and for people who cannot talk to it (a viewer can read costs and agents). Commands run the same tools the manager uses, as you: only what your roles allow is offered, a change asks first, and it is recorded under your identity.

```
manager> /agents
ID       STATE
donna    SLEEPING
rosie    WORKING
manager> /spend
totalUsd  212.4
manager> /budget donna 5 daily
Run: set_agent_budget {"id":"donna","spendLimitUsd":5,"period":"daily"}
This changes the factory. Allow it? [y/N] y
Done: set an agent's spend limit.
```

| | |
|---|---|
| Look | `/agents`, `/agent <id>`, `/policy <agent>`, `/status`, `/runs [agent] [--active] [--limit n]`, `/run <id>`, `/ledger [agent] [--limit n]`, `/models`, `/skills`, `/incidents`, `/schedules` |
| Money | `/spend`, `/report [current\|last]`, `/compute`, `/budgets`, `/budget <agent> <amount> daily\|monthly`, `/factory-budget total=<$> ai=<$> infra=<$> alert=0.8,1` |
| Agents | `/pause`, `/resume`, `/isolate`, `/wake`, `/reset`, `/retire`, `/reinstate` `<agent>`; `/cancel <run id>` |
| Approvals | `/approvals`, `/approve <id> [notes]`, `/reject <id> [notes]` |

`/help` lists them all. Add `--json` for the factory's answer as JSON (values under secret-looking names are hidden). They also run outside the conversation, for scripts:

```
factory agents
factory spend --json | jq .totalUsd
factory budget donna 5 daily --yes
```

A command that changes state asks on a terminal, and is refused elsewhere unless you pass `--yes`. A script's arguments are taken exactly as given (an argument that contains quotes or the text `--yes` is just text); put `--` before any argument that begins with `--`, for example `factory approve 12 -- "--careful with this"`. Amounts are written plainly (`5`, `$12.50`, `1,250`), not `1e3`. Text from the factory and from agents is shown with control and invisible formatting characters removed (so it cannot hide or reorder what you read); that also drops zero-width joiners, which splits some emoji sequences and affects a few scripts such as Persian. Exit status is 0 on success and 1 on any failure (not signed in, a role you do not hold, a refusal from the factory). Free text with no usable manager says why (not admitted, over budget, or your role) and points at these commands.

## How people sign in

`factory login --url <address>` (or `/login` in the conversation) opens the factory's own login page in your browser (S13). Sign in with any identity provider the factory is configured for (Google, Meta, Cloudflare, OIDC). The factory then sends a one-time code to a listener the CLI runs on `127.0.0.1`, checked against a per-attempt state. The CLI trades that code, together with its PKCE verifier, at `POST /api/v1/auth/cli/token` for your own revocable `cli` device-family key (`fk_…`). It keeps that key in the Keychain or its credentials file and sends it as `Authorization: Bearer`. Signing in again rotates the same key. The CLI fetches nothing before sign-in. The old `GET /.well-known/factory-cli` discovery document and the `FACTORY_OIDC_CLI_*` settings were retired in S17. Sign-ins saved by earlier versions (Cloudflare Access, OIDC) keep working until they expire.


## What the manager can do for you

Only what **your own roles** allow (CL3). The manager has no power of its own: it asks for a tool, the CLI runs it as you, and the factory decides. A viewer can read costs; only an admin can set a budget. Every state-changing call is shown to you and runs only if you say yes (the answer must be typed after the question appears, so piped or pasted-ahead input cannot approve a change), and it is ledgered under your identity exactly as if you had used the console.

Tools: list and inspect agents, factory metrics, spend (by agent, the monthly report, compute, the factory budgets), set factory budgets, set an agent's budget, list runs, ledger rows, held approvals and decide them, pause/resume/isolate/wake/reset an agent, cancel a run, retire and reinstate an agent, models, skills, incidents and schedules.

Left to the console on purpose: registering, deploying and purging agents, and anything that supplies or reads a credential (CL6, K5). Nothing sensitive is shown in the terminal or sent to the manager; values under secret-looking names are hidden.

To talk to the manager at all you need the `agents.converse` privilege, which the Bouncer gives the `operator` role. Today a person who signs in through Cloudflare Access is an admin if their email is in `FACTORY_ADMIN_EMAILS` and a viewer otherwise (`packages/auth/src/access.ts`), so **only admins can use the manager yet**. A viewer who tries is told what role is missing. Giving other people the operator role is a Bouncer and Access question, not a CLI one (GAP-190, open).

## Setting up the manager

The Factory Manager is optional house staff (`agents/staff/factory-manager`, L2, L5). Until an operator admits it, `factory` has nobody to talk to; it tells you so. To admit it:

1. Register and deploy the cartridge as you would any other (see `agents/staff/factory-manager/README.md`).
2. Set its policy (E7): grant the `models` route, a model, and a small daily budget. It makes a few model calls per question.
3. The people who should use it need the `operator` role, which today means being in `FACTORY_ADMIN_EMAILS` (see above).

Every model call it makes is metered through the gatekeeper-egress and charged to its own budget.

## How it works

- **Sign-in.** `cloudflared access login` for the browser flow; the assertion goes in the Keychain through `security -i` (never on a command line). Requests carry it as `cf-access-token`; the proxy turns it into the assertion the control plane verifies.
- **Conversation.** A turn is `POST /api/v1/agents/:id/conversation`; the answer is read from `GET /api/v1/agents/:id/replies`, the console's own reply path (AM2). The manager and any agent you connect to use the same two calls.
- **Tools.** Each turn the CLI sends the manager the tools your roles allow. The manager answers with a message, tool requests, or a request to connect you (`agents/staff/factory-manager/README.md` has the shapes). The CLI runs the tools, returns the results as the next turn, and stops a manager that asks for more than 8 rounds.
- **Answers are grounded (CL7).** The manager is told to quote only figures from tool results. It sends a plain answer as plain text so the factory can add its usual `[no tools called]` footnote to one given without tools, and the CLI shows it. Tool and connect requests are the only JSON.

## Tests

```
npm test -w @beercanlabs/factory-cli          # unit tests against an in-memory factory
npm test -w @beercanlabs/factory-control-plane # includes cli.e2e.test.ts against the real control plane
(cd agents/staff/factory-manager && python3 -m unittest discover -s tests)
```

Not tested here: the real Keychain, the `cloudflared` browser login, and a real model driving the tools. Try those on a Mac against your factory.
