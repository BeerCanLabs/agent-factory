# Inspector (`@beercanlabs/factory-inspector`)

The Inspector watches the factory and says what it sees: run progress, prompt traces, events, metrics and triage (DESIGN_AUTHORITY.md §6.15, GAP-103). It never decides anything and never answers an HTTP request: the handlers stay in `packages/control-plane`. The dependency points one way: the control plane and the egress depend on the Inspector, never the reverse.

This package is being extracted in steps (the Inspector flow work stream, TSK-135 to TSK-141). It holds so far:

- `progress.ts`: what `gatekeeper-egress` reports about each outbound call it handles for a run. `ProgressEmitter` (a bounded in-memory queue shipped in batches by a timer, one request in flight, never delaying a proxied call; events are dropped with a log line when the queue is full or a send fails), `ProgressCall` (one call's start and end, reported once each), `safeIdent` (route ids and model names are identifiers; anything else is not reported) and the event types. Metadata only: no bodies, URLs, headers or secrets (E3, S1). The log lines keep their `[gatekeeper-egress]` prefix, because this step moves code and changes no behavior.
- `traces.ts`: prompt traces (`FACTORY_TRACE_PROMPTS`): `traceConfigFromEnv`, `writeTrace` (secrets redacted with the ledger's `redactSecrets`) and `pruneTraces` (files older than `FACTORY_TRACE_TTL_SECONDS`, default one day). Off unless enabled and a directory is known.

- `events.ts`: what the factory announces (`FactoryEvent`: a ledger row, a run state change or a progress event) and how it leaves. `EventHub` (fan-out; a throwing subscriber is logged and does not stop the rest), `tapLedger` and `hubOf` (publish every appended ledger row; moved as it is, GAP-105), `runEvent` (over the structural `RunSnapshot`, so the package does not import the Landlord's run), `isBusWorthy` (run outcomes and blocks, budget alerts, crashes, approval requests), and the bus sinks: `fileSink` (NDJSON), `eventBridgeSink` (source `agent-factory`, detail-type `factory.<kind>`, at most 10 entries per call), `busSinkFromEnv` (`FACTORY_EVENT_BUS`) and `attachBus` (batches, ships, retries a failed batch ahead of newer events).
- `run-progress.ts`: what the control plane keeps of a run's progress. `sanitizeProgress` (only the declared fields survive), `RunProgressEvent` (the egress event plus a per-run `seq`) and `RunProgress` (a bounded ring per run, a bounded number of runs, long-poll readers).

The routes that serve these (`progress-routes.ts`, `stream.ts`) stay in `packages/control-plane`, because they own the Bouncer privilege calls and the run-token rule. The metrics instruments and the triage rule are still in `packages/control-plane` and move in the next tasks. `packages/telemetry` (`initTelemetry`) stays a separate package that the Inspector hosts (D-A).

The package imports nothing from `control-plane` or a gatekeeper.
