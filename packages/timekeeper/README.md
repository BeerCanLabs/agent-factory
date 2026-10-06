# Timekeeper (`@beercanlabs/factory-timekeeper`)

The Timekeeper decides when an agent is due. This package holds the cron rule; the rest of the Timekeeper still lives in `packages/control-plane` (`schedules.ts`, `scheduler.ts`) and moves here in later steps (DESIGN_AUTHORITY.md, Timekeeper flow work stream).

- `cronMatches(schedule, dateOrParts?)`: whether a 5-field cron matches a `Date` (read in the process's local time) or a `ZonedTimeParts`. Each field is `*`, a number, a range `a-b`, a step `*/n`, or a comma list of those. Day of week `7` is Sunday.
- `getZonedTimeParts(date?, timeZone?)`: the wall-clock parts of a `Date` in an IANA time zone (default `DEFAULT_TIMEZONE`); falls back to local time when the zone is unknown.
- `isTimeZone(tz)`: true when the runtime knows the IANA time zone.
- `cronIssue(expr)`: why a cron is refused, or `null` when it is valid. It accepts exactly what `cronMatches` evaluates.
- `DEFAULT_TIMEZONE`: `America/Los_Angeles`, the zone a schedule uses when it names none.
- `ZonedTimeParts`: the parts type `cronMatches` and `getZonedTimeParts` share.

The package has no runtime dependencies and imports nothing from `control-plane`.
