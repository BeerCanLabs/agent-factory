# Inspector (`@beercanlabs/factory-inspector`)

The Inspector watches the factory and says what it sees: run progress, prompt traces, events, metrics and triage (DESIGN_AUTHORITY.md §6.15, GAP-103). It never decides anything and never answers an HTTP request: the handlers stay in `packages/control-plane`. The dependency points one way: the control plane and the egress depend on the Inspector, never the reverse.

This package is being extracted in steps (the Inspector flow work stream, TSK-135 to TSK-141). It holds so far:

- `progress.ts`: what `gatekeeper-egress` reports about each outbound call it handles for a run. `ProgressEmitter` (a bounded in-memory queue shipped in batches by a timer, one request in flight, never delaying a proxied call; events are dropped with a log line when the queue is full or a send fails), `ProgressCall` (one call's start and end, reported once each), `safeIdent` (route ids and model names are identifiers; anything else is not reported) and the event types. Metadata only: no bodies, URLs, headers or secrets (E3, S1). The log lines keep their `[gatekeeper-egress]` prefix, because this step moves code and changes no behavior.
- `traces.ts`: prompt traces (`FACTORY_TRACE_PROMPTS`): `traceConfigFromEnv`, `writeTrace` (secrets redacted with the ledger's `redactSecrets`) and `pruneTraces` (files older than `FACTORY_TRACE_TTL_SECONDS`, default one day). Off unless enabled and a directory is known.

The event hub, bus sinks, progress ring, metrics instruments and triage rule are still in `packages/control-plane` and move in the next tasks. `packages/telemetry` (`initTelemetry`) stays a separate package that the Inspector hosts (D-A).

The package imports nothing from `control-plane` or a gatekeeper.
