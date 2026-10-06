# Timekeeper roadmap: schedules an agent can rely on

Status: **gaps recorded, not started.** The extraction of the Timekeeper into its own package is planned separately
(`DESIGN_AUTHORITY.md` §6.15, roadmap step 3, the Timekeeper flow work stream, TSK-117 to TSK-123) and is moves only.
This file records what is wrong or missing for the person who asks an agent to schedule something, so the work can be
planned when the extraction is done. Owner of the intent: Dale (chat, 2026-10-06). It is for any person or AI agent
picking the work up; it is self-contained, and everything in it can be checked against the code paths named below.

## Intent

**When a person tells their agent to schedule something, or asks what is scheduled, the agent does exactly what was
asked and the person can tell that it did.** That means the right time in the person's own time zone, a way to say
"once" as well as "every", an answer to "when does it next run", a schedule that fires or tells the person why it did
not, and one way for an agent to do all of this.

## What happens today (checked 2026-10-06)

**The person asks for a recurring job** ("a daily report at 6am"):

1. The person's message reaches the agent through the Gatekeeper's ingress and the agent gets a run.
2. The model calls the agent's schedule tool with a cron, a prompt it writes to itself, a name and optionally a time
   zone. The agent's code adds the channel the message came from. (SM-donna has its own tools, `create_scheduled_action`
   in `agent.py`; the shared skill `factory-schedules` has `schedule_create`.)
3. The agent calls `POST $FACTORY_URL/api/v1/schedules` with its run token. The control plane
   (`packages/control-plane/src/schedules.ts`) scopes the token to the agent's own schedules, checks the agent, cron,
   prompt and time zone, saves the schedule in `schedules.json` and ledgers `SCHEDULE_CREATED` with the run as actor.
4. The result returns to the model, which tells the person.
5. Each minute the loop in `packages/control-plane/src/index.ts` asks `ScheduleStore.checkDue`, and for each due
   schedule starts a run (`trigger: 'schedule'`) whose input is the stored prompt, the channel and the schedule's
   id and name. The agent answers in the channel.

**The person asks what is scheduled:** the agent calls `GET /api/v1/schedules` with its run token, which returns only
that agent's schedules (id, name, cron, time zone, prompt, enabled, created and last-run times), and the model
summarizes them.

## Gaps

Each is a gap between the intent and the code. None is registered in `DESIGN_AUTHORITY.md` yet; register one when its
turn comes. The Donna Test applies to each: say whether the fix is the Factory's or a cartridge's or a skill's.

### 1. A time zone nobody chose is applied silently

`DEFAULT_TIMEZONE` is `America/Los_Angeles` in the control plane (`schedules.ts`) and again in SM-donna's tool
description ("cron ... in Pacific Time"). If the model does not pass a zone, a person in New York who asks for "6am"
gets 6am Pacific, with no error and no mention in the reply. Nothing knows the person's own zone.
*Factory or cartridge:* both. The Factory has no notion of an agent owner's zone to default to; the cartridge decides
whether to ask. Open decision: does the owner (or the person) have a time zone the Factory stores, or must the agent
ask every time?

### 2. Only "every", never "once"

The Timekeeper's role in §6.15 names "one-shot wakeup timers", and SM-donna's cartridge says it schedules "recurring
and one-off executive actions" (`action-scheduling` in `cartridge.yaml`). No one-shot timer exists in code, route,
store, test or console. "Remind me tomorrow at 3" has to become a cron that the agent later deletes; nothing deletes
it, so it can fire again. Registered in `DESIGN_AUTHORITY.md` as GAP-096 (the role text promises what is not there).
*Factory:* a one-shot is a Timekeeper capability. Open decision: build it, or remove the words from §6.15 and from
the cartridges that repeat them.

### 3. "When does it run next?" has no answer from the Factory

A schedule stores `lastRunAt` and `lastRunMinute`, never a next run. The agent can read back the cron, but to say
"next Tuesday at 6am" it must do cron and time-zone arithmetic itself, which a model gets wrong. *Factory:* the
Timekeeper knows the rule and the zone and should return the next fire time with the list.

### 4. A missed minute is lost

The loop checks once a minute from an in-memory timer and remembers only the last minute it fired
(`lastRunMinute`). If the control plane is down, restarting or late at the minute a schedule was due, that firing
never happens and nothing records that it was skipped. A tick that lands late could also step over a minute.
*Factory:* decide the rule: catch up within a window, or record a missed firing the person can see.

### 5. A schedule that cannot run does not tell the person

A due schedule starts a run through `createRun`. If the agent is over its budget, paused or isolated, the start is
refused and the minute is not retried. The refusal is ledgered, but the person who asked for the daily report simply
does not get it and is told nothing. A person's message to an agent that is over budget now gets an answer from the
Gatekeeper (GAP-091); a schedule has no person in the loop to answer to. *Factory:* decide who tells the person,
where (the schedule's channel), and whether the Timekeeper or the Landlord says it.

### 6. A schedule cannot be changed, only replaced

The API has create, list and delete (`GET`, `POST`, `DELETE /api/v1/schedules`). There is no edit and no pause: to
move a report from 6am to 7am the agent deletes and creates a new one, with a new id, and a create that follows a
failed delete leaves two. `enabled` can be set at creation and never changed. *Factory:* an update route, and a
pause that keeps the schedule.

### 7. The person cannot see or manage schedules without asking the agent

The console has no schedules screen, and `SPEC.md` does not list `/api/v1/schedules` among the routes. The only way
for a person to know what is scheduled is to ask the agent, and the only record of who created a schedule is the
ledger row naming the run, not the person. *Factory:* a schedules view for the owner, the route in `SPEC.md`, and a
decision on whether a schedule records the person who asked.

### 8. Two ways to schedule, and the better one is not used by the agent that needs it

SM-donna carries its own copy of the schedule tools (`factory_create_schedule` and friends) while the shared skill
`factory-schedules` (repository `skill-factory-schedules`) also parses phrases such as "weekdays at 7:30" and refuses
ambiguous times such as "daily at 7". Donna's tool takes a raw cron string and relies on the model to convert the
person's words. *Cartridge or skill, not the Factory* (the Donna Test): a cartridge should use the shared skill. The
Factory's part is to make sure the skill is offered and works for every agent.

## Order of work

1. Finish the extraction (TSK-117 to TSK-123). Every gap above is easier once the Timekeeper is one package with one
   contract, and none is solved by it.
2. Cheap and independent: gap 3 (a next-run time in the list), gap 7's `SPEC.md` line, and gap 8 (move SM-donna to the
   shared skill).
3. Decide, with Dale, the open questions: gap 1 (whose time zone), gap 2 (build one-shots or remove the words),
   gap 4 (catch-up or visible miss), gap 5 (who tells the person).
4. Then build in this order: one-shot timers, update and pause, the owner's schedules view, the person-facing refusal,
   missed-firing handling.

Plan each part in the shape of the Treasurer and Bouncer extractions: small tasks, each green on its own, decisions
written as "Confirmed by Dale" before anything is handed to an executor, and the plan checked against the code by
someone other than its author.

## Constraints that stay

- What an agent understands by "6am", and how it phrases the reply, stays in the cartridge (the Donna Test); what time
  a schedule fires, and whether a firing happened, is the Factory's.
- Schedules are agent-scoped (E7): a run schedules only for its own agent, and another agent's schedule is
  indistinguishable from a missing one. Creates and deletes stay ledgered, and the ledger never holds the prompt (E3).
- No new interface beyond API, webhooks, WebSockets and events (`KPF.md`).
