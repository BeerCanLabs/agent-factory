// DESIGN_AUTHORITY.md §6.15 (Inspector), GAP-103: the event hub, the ledger tap and the bus sinks, the per-run progress
// ring and its sanitizer, the egress progress emitter, prompt traces, the run metrics instruments and the triage rule
// exist once, in packages/inspector, and the dependency points one way: the control plane and the egress depend on the
// Inspector.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

// What this guard does not do, so the next reader does not mistake it for more:
//  - It is line-based. A rule copied under another name, or an instrument created through an alias of `meter`, passes.
//    Definitions of the Inspector's own names, its metric names and its triage literals are what it can see.
//  - It does NOT guard `'TIMEOUT'`: the Cloud Build status set in `control-plane/src/gcp/cloudbuild.ts` uses the same
//    word. The triage category is caught by `'SECRET_MISSING'` and `'CRASH_LOOP'`, which nothing else uses.
//  - It does NOT guard the egress's own instruments (`factory.gatekeeper-egress.*`, GAP-109): they belong to the
//    Gatekeeper, the Tinman and the Treasurer and stay in `gatekeeper-egress.ts` until those members are extracted.
//  - `createInspector(` may be called from the control plane's composition root only. A second Inspector would be a
//    second hub: events published to one would not reach subscribers of the other.

/** Names the Inspector owns. A definition of any of them outside the package is a second copy. */
const OWNED_VALUES =
  'EventHub|RunProgress|ProgressEmitter|ProgressCall|sanitizeProgress|safeIdent|writeTrace|pruneTraces|traceConfigFromEnv|factoryMetrics|incidentsFromRuns|tapLedger|attachBus|isBusWorthy|fileSink|eventBridgeSink|busSinkFromEnv|createInspector';
const OWNED_TYPES = 'ProgressEvent|ProgressOutcome|RunProgressEvent|FactoryEvent|BusSink|FactoryMetrics|Incident|TriageRun|RunSnapshot|TraceConfig|TraceRecord|Inspector';

/** A second copy of the Inspector's rule. Each pattern is a definition or a literal, never a use. */
const SECOND_COPY: Array<{ what: string; re: RegExp }> = [
  { what: 'a function, constant or class the Inspector owns, defined again', re: new RegExp(`\\b(?:function|const|let|var|class)\\s+(?:${OWNED_VALUES})\\b`) },
  {
    what: 'a type the Inspector owns, defined again',
    re: new RegExp(`\\b(?:interface)\\s+(?:${OWNED_TYPES})\\b|\\btype\\s+(?:${OWNED_TYPES})\\s*(?:<[^>]*>)?\\s*=`),
  },
  { what: 'a second hub or progress ring built', re: /\bnew\s+(?:EventHub|RunProgress)\s*\(/ },
  { what: 'a run metrics instrument registered again', re: /['"]factory\.(?:runs\.(?:active|finished)|run\.duration|health\.events)['"]/ },
  { what: 'the triage categories written again', re: /['"](?:SECRET_MISSING|CRASH_LOOP)['"]/ },
  { what: 'the trace switches or the bus switch read again', re: /\bFACTORY_(?:TRACE_(?:PROMPTS|DIR|TTL_SECONDS)|EVENT_BUS)\b/ },
];

const matches = (src: string, patterns = SECOND_COPY) =>
  src.split('\n').flatMap((line, i) => patterns.filter((c) => c.re.test(line)).map((c) => `${i + 1}: ${line.trim()}  [${c.what}]`));

/** Where the rule used to live and could be copied back: the other kernel packages' own source. */
const GUARDED = /^packages\/(control-plane|gatekeeper-egress|gatekeeper-ingress)\/src\/.*\.ts$/;
const nonTest = (p: string) => !p.endsWith('.test.ts');

/** A call that makes an Inspector (the definition `function createInspector(` is not a call). */
const MAKES_INSPECTOR = /(?<!function\s)\bcreateInspector\s*\(/;
const INSPECTOR_OWNER = 'packages/control-plane/src/index.ts';

describe('Inspector: one copy of the events, progress, traces, metrics and triage rules', () => {
  it('the patterns recognize what they exist to forbid, and not what callers legitimately do', () => {
    const forbidden = [
      'export class EventHub {',
      'export function tapLedger<T extends LedgerStore>(ledger: T, hub: EventHub): T {',
      'const sanitizeProgress = (raw: unknown) => undefined;',
      'export class RunProgress {',
      'export class ProgressEmitter {',
      'export function writeTrace(cfg: TraceConfig, record: TraceRecord): string | null {',
      'export function factoryMetrics(meter: Meter): FactoryMetrics {',
      'function incidentsFromRuns(runs) {',
      'export type ProgressEvent = {',
      'type FactoryEvent = { kind: string };',
      'interface BusSink {',
      'const hub = new EventHub();',
      "meter.createCounter('factory.runs.finished', { description: 'x' });",
      "meter.createObservableGauge('factory.runs.active', {});",
      "category: r.missing ? 'SECRET_MISSING' : 'CRASH_LOOP',",
      "const enabled = process.env.FACTORY_TRACE_PROMPTS === '1';",
      "const spec = env.FACTORY_EVENT_BUS;",
    ];
    for (const line of forbidden) assert.equal(matches(line).length >= 1, true, `should be caught: ${line}`);

    const allowed = [
      "import { createInspector, factoryMetrics, incidentsFromRuns } from '@beercanlabs/factory-inspector';",
      "import type { ProgressEvent } from '@beercanlabs/factory-inspector';",
      "import { ProgressCall, ProgressEmitter, type ProgressEvent } from '@beercanlabs/factory-inspector';",
      'const progress = opts.control.progress ? new ProgressEmitter((events) => opts.control.progress!(events), opts.progress) : undefined;',
      'progress?(events: ProgressEvent[]): Promise<void>;',
      'const incidents = incidentsFromRuns(state.runs.list({}));',
      'const ledger = inspector.tapLedger(opened.store);',
      'if (busSink) inspector.attachBus(busSink);',
      "state.metrics?.health.add(1, { agent: agentId, kind: 'crash_loop' });",
      "ledger.append({ action: 'CRASH_LOOP_PAUSED', actor: SYSTEM.health });",
      "const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILURE', 'TIMEOUT']);",
      "meter.createCounter('factory.gatekeeper-egress.requests', { description: 'Egress requests by route and outcome' });",
      '  traces: traceConfigFromEnv(),',
    ];
    for (const line of allowed) assert.deepEqual(matches(line), [], `should be allowed: ${line}`);

    assert.equal(MAKES_INSPECTOR.test('const inspector = createInspector();'), true);
    assert.equal(MAKES_INSPECTOR.test('  inspector: createInspector({ progressRuns: 2 }),'), true);
    assert.equal(MAKES_INSPECTOR.test('export function createInspector(options: InspectorOptions = {}): Inspector {'), false, 'the definition is not a call');
    assert.equal(MAKES_INSPECTOR.test("import { createInspector } from '@beercanlabs/factory-inspector';"), false, 'an import is not a call');
  });

  it('the patterns see the real originals in packages/inspector, so they are not vacuous', () => {
    const originals: Array<[string, string]> = [
      ['packages/inspector/src/events.ts', 'EventHub'],
      ['packages/inspector/src/events.ts', 'tapLedger'],
      ['packages/inspector/src/events.ts', 'FactoryEvent'],
      ['packages/inspector/src/run-progress.ts', 'RunProgress'],
      ['packages/inspector/src/run-progress.ts', 'sanitizeProgress'],
      ['packages/inspector/src/progress.ts', 'ProgressEmitter'],
      ['packages/inspector/src/progress.ts', 'ProgressEvent'],
      ['packages/inspector/src/traces.ts', 'writeTrace'],
      ['packages/inspector/src/traces.ts', 'FACTORY_TRACE_PROMPTS'],
      ['packages/inspector/src/metrics.ts', 'factoryMetrics'],
      ['packages/inspector/src/metrics.ts', 'factory.runs.finished'],
      ['packages/inspector/src/triage.ts', 'incidentsFromRuns'],
      ['packages/inspector/src/triage.ts', 'SECRET_MISSING'],
      ['packages/inspector/src/inspector.ts', 'createInspector'],
    ];
    for (const [file, name] of originals) {
      assert.ok(matches(read(file)).some((m) => m.includes(name)), `${file} no longer carries ${name} where the guard looks for it`);
    }
  });

  it('control-plane, gatekeeper-egress and gatekeeper-ingress source do not define the Inspector\'s rules again', () => {
    const found = files('packages', (p) => GUARDED.test(p) && nonTest(p)).flatMap((f) => matches(read(f)).map((m) => `${f}:${m}`));
    assert.deepEqual(found, [], 'events, progress, traces, run metrics and the triage rule are the Inspector\'s: import them from @beercanlabs/factory-inspector');
  });

  it('only the control plane\'s composition root makes an Inspector', () => {
    const found = files('packages', (p) => /^packages\/[^/]+\/src\/.*\.ts$/.test(p) && nonTest(p) && p !== INSPECTOR_OWNER && !p.startsWith('packages/inspector/')).flatMap((f) =>
      read(f).split('\n').flatMap((l, i) => (MAKES_INSPECTOR.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])),
    );
    assert.deepEqual(found, [], `a second Inspector is a second hub: only ${INSPECTOR_OWNER} calls createInspector`);
    assert.ok(MAKES_INSPECTOR.test(read(INSPECTOR_OWNER)), `${INSPECTOR_OWNER} no longer makes the Inspector, so nothing publishes events`);
  });

  it('packages/inspector depends on no control-plane, gatekeeper or console package, in its manifest or its source', () => {
    const pkg = JSON.parse(read('packages/inspector/package.json')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    const back = names.filter((n) => /^@beercanlabs\/factory-(control-plane|gatekeeper-.+|console)$/.test(n));
    assert.deepEqual(back, [], 'the dependency points one way: the control plane and the egress depend on the Inspector');

    const IMPORT_BACK = /\bfrom\s+['"](?:@beercanlabs\/factory-(?:control-plane|gatekeeper-[a-z-]+|console)|(?:\.\.\/)+(?:control-plane|gatekeeper-[a-z-]+|console))\b/;
    assert.equal(IMPORT_BACK.test("import { x } from '@beercanlabs/factory-gatekeeper-egress';"), true);
    const upToControlPlane = ['..', '..', 'control-plane', 'src', 'app.js'].join('/'); // built, so this file holds no relative cross-package import itself
    assert.equal(IMPORT_BACK.test(`import { x } from '${upToControlPlane}';`), true);
    assert.equal(IMPORT_BACK.test("import { x } from '@beercanlabs/factory-ledger';"), false);
    assert.equal(IMPORT_BACK.test("import { x } from './events.js';"), false);
    const imports = files('packages/inspector/src', (p) => p.endsWith('.ts') && nonTest(p)).flatMap((f) =>
      read(f).split('\n').filter((l) => IMPORT_BACK.test(l)).map((l) => `${f}: ${l.trim()}`),
    );
    assert.deepEqual(imports, [], 'the Inspector takes what it needs from another member by a callback or a structural type, never by importing it');
  });
});
