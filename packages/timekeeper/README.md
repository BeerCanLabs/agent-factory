# Timekeeper (`@beercanlabs/factory-timekeeper`)

The Timekeeper decides when an agent is due. This package holds the cron rule and the record and store of dynamic schedules; the `/api/v1/schedules` handler stays in `packages/control-plane/src/schedules.ts`, and the control plane starts the clock in a later step (DESIGN_AUTHORITY.md, Timekeeper flow work stream).

- `cronMatches(schedule, dateOrParts?)`: whether a 5-field cron matches a `Date` (read in the process's local time) or a `ZonedTimeParts`. Each field is `*`, a number, a range `a-b`, a step `*/n`, or a comma list of those. Day of week `7` is Sunday.
- `agentsDueForCron(agents, date?)`: the agents with a cron trigger that matches `date`, once per matching trigger. Typed over a structural agent (`id` and `triggers` of `{ type, schedule? }`), so the package does not import the Registrar's record, and the result keeps the caller's own record type.
- `getZonedTimeParts(date?, timeZone?)`: the wall-clock parts of a `Date` in an IANA time zone (default `DEFAULT_TIMEZONE`); falls back to local time when the zone is unknown.
- `isTimeZone(tz)`: true when the runtime knows the IANA time zone.
- `cronIssue(expr)`: why a cron is refused, or `null` when it is valid. It accepts exactly what `cronMatches` evaluates.
- `DEFAULT_TIMEZONE`: `America/Los_Angeles`, the zone a schedule uses when it names none.
- `ScheduledAction`, `ScheduleStore`: a dynamic schedule and its store. The store is in memory, or backed by a JSON file when given a path (the control plane passes `FACTORY_SCHEDULES_PATH`, else `DATA_DIR/schedules.json`). `checkDue(date?)` returns the enabled schedules whose cron matches `date` in their own time zone, records `lastRunMinute` and `lastRunAt`, and does not return a schedule twice in the same minute.
- `createTimekeeper({ agents, schedules, fire, now? })`: the contract. `tick()` asks which cartridge crons match now (`agents()` returns the cartridges) and which schedules in the store are due, and calls `fire` for each with a `FireRequest`: `{ kind: 'cartridge', agentId }` or `{ kind: 'schedule', schedule }`. `start(intervalMs = 60000)` runs `tick` on an interval and returns the function that stops it. A `fire` that throws or rejects is logged and does not stop the other firings. The Timekeeper never starts a run: the caller's `fire` decides what to do (the composition root gives it to the Landlord). Not yet used by the control plane.
- `ZonedTimeParts`: the parts type `cronMatches` and `getZonedTimeParts` share.

The package has no runtime dependencies and imports nothing from `control-plane`.
