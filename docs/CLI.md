# The Factory CLI

`factory` is a terminal client for a factory instance (DESIGN_AUTHORITY.md §6.17). You point it at your factory, sign in as yourself, and talk to the **Factory Manager**. The manager answers questions about cost, agents, budgets, approvals and runs, and can make changes. It can also connect you to an agent so you talk to that agent directly.

It is a client of the factory's existing API (KPF): it adds no interface and no logic the web console lacks.

## Install and sign in (macOS)

```
brew install cloudflared          # the identity-aware proxy's own client
npm install && npm run build      # in a clone of this repository
npm link -w @beercanlabs/factory-cli   # puts `factory` on your PATH

factory login agent-factory.example.com
```

`factory login` opens your browser for the factory's single sign-on (Cloudflare Access on AWS). The signed assertion is kept in the macOS Keychain and renewed when it expires. The CLI never holds a `FACTORY_TOKEN` and sends no identity of its own; the factory verifies the assertion (A2). `factory logout` forgets it, and `factory whoami` shows who you are and your roles.

`FACTORY_URL` overrides the saved address. `FACTORY_CLI_ACCESS_TOKEN` supplies an Access assertion directly (for example from `cloudflared access token`) when you cannot use the browser flow.

## Use

```
$ factory
Connected to https://agent-factory.example.com as cloudflare:dale@example.com (admin, operator, ...). Type /help.
manager> what have we spent this month?
> get_spend_report {"period":"current"}
So far this month: $212.40 (AI $171.10, infrastructure $41.30), 71% of the $300 total budget.
manager> set donna to $5 a day
The manager wants to run: set_agent_budget {"id":"donna","spendLimitUsd":5,"period":"daily"}
This changes the factory. Allow it? [y/N] y
Donna's budget is now $5 a day.
manager> let me talk to donna
Connecting you to donna.
Connected to donna. /manager to go back.
donna> good morning
...
```

| Command | |
|---|---|
| `/connect <agent>` | talk to an agent directly |
| `/manager` | back to the Factory Manager |
| `/whoami` | who you are signed in as |
| `/help`, `/exit` | |

## What the manager can do for you

Only what **your own roles** allow (CL3). The manager has no power of its own: it asks for a tool, the CLI runs it as you, and the factory decides. A viewer can read costs; only an admin can set a budget. Every state-changing call is shown to you and runs only if you say yes, and it is ledgered under your identity exactly as if you had used the console.

Tools: list and inspect agents, factory metrics, spend (by agent, the monthly report, compute, the factory budgets), set factory budgets, set an agent's budget, list runs, ledger rows, held approvals and decide them, pause/resume/isolate/wake/reset an agent, cancel a run, retire and reinstate an agent, models, skills, incidents and schedules.

Left to the console on purpose: registering, deploying and purging agents, and anything that supplies or reads a credential (CL6, K5). Nothing sensitive is shown in the terminal or sent to the manager; values under secret-looking names are hidden.

To talk to the manager at all you need the `agents.converse` privilege, which the Bouncer gives the `operator` role. Today a person who signs in through Cloudflare Access is an admin if their email is in `FACTORY_ADMIN_EMAILS` and a viewer otherwise (`packages/auth/src/access.ts`), so **only admins can use the manager yet**. A viewer who tries is told what role is missing. Giving other people the operator role is a Bouncer and Access question, not a CLI one (GAP-189, open).

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
- **Answers are grounded (CL7).** The manager is told to quote only figures from tool results. The factory adds its usual footnote to an answer given without tools, and the CLI shows it.

## Tests

```
npm test -w @beercanlabs/factory-cli          # unit tests against an in-memory factory
npm test -w @beercanlabs/factory-control-plane # includes cli.e2e.test.ts against the real control plane
(cd agents/staff/factory-manager && python3 -m unittest discover -s tests)
```

Not tested here: the real Keychain, the `cloudflared` browser login, and a real model driving the tools. Try those on a Mac against your factory.
