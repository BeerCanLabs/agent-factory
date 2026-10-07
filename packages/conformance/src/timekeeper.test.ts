// DESIGN_AUTHORITY.md §6.15 (Timekeeper), GAP-095: the cron rule, the schedule store and the clock exist once, in
// packages/timekeeper, and the dependency points one way: the control plane depends on the Timekeeper.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

/** A second copy of the Timekeeper's rule: its functions or store defined again, its bookkeeping field, or its store's due check. */
const SECOND_COPY = [
  /\b(?:function|const|let|var)\s+(?:cronMatches|cronIssue|getZonedTimeParts)\b/,
  /\bclass\s+ScheduleStore\b/,
  /\blastRunMinute\b/,
  /\bcheckDue\s*\(/,
];

/** A call that starts the Timekeeper's clock (the definition `function createTimekeeper(` is not a call). */
const CLOCK_START = /(?<!function\s)\bcreateTimekeeper\s*\(/;

const matches = (src: string, patterns: RegExp[]) =>
  src.split('\n').flatMap((line, i) => (patterns.some((re) => re.test(line)) ? [`${i + 1}: ${line.trim()}`] : []));

/** The packages that must not carry their own copy: where the cron rule, the schedule store and the firing loop used to live. */
const GUARDED = /^packages\/(control-plane|gatekeeper-egress|gatekeeper-ingress)\/src\/.*\.ts$/;
const CLOCK_OWNER = 'packages/control-plane/src/index.ts';

describe('Timekeeper: one copy of the cron rule and one clock', () => {
  it('the patterns recognize what they exist to forbid, and not what callers legitimately do', () => {
    assert.equal(matches('export function cronMatches(schedule: string): boolean {', SECOND_COPY).length, 1);
    assert.equal(matches('const cronIssue = (expr: string) => null;', SECOND_COPY).length, 1);
    assert.equal(matches('function getZonedTimeParts(date: Date) {', SECOND_COPY).length, 1);
    assert.equal(matches('export class ScheduleStore {', SECOND_COPY).length, 1);
    assert.equal(matches('schedule.lastRunMinute = minuteKey;', SECOND_COPY).length, 1);
    assert.equal(matches('const due = store.checkDue(new Date());', SECOND_COPY).length, 1);
    assert.equal(matches("import { cronIssue, isTimeZone } from '@beercanlabs/factory-timekeeper';", SECOND_COPY).length, 0, 'importing is the point');
    assert.equal(matches('const cronProblem = cronIssue(body.cron);', SECOND_COPY).length, 0, 'calling the rule is the point');
    assert.equal(matches('import { ScheduleStore } from "@beercanlabs/factory-timekeeper"; new ScheduleStore(path);', SECOND_COPY).length, 0, 'using the store is the point');

    assert.equal(CLOCK_START.test('  createTimekeeper({'), true);
    assert.equal(CLOCK_START.test('const tk = createTimekeeper (opts);'), true);
    assert.equal(CLOCK_START.test('export function createTimekeeper(options: TimekeeperOptions): Timekeeper {'), false, 'the definition is not a call');
    assert.equal(CLOCK_START.test("import { createTimekeeper } from '@beercanlabs/factory-timekeeper';"), false, 'an import is not a call');
  });

  it('control-plane, gatekeeper-egress and gatekeeper-ingress source do not define the cron rule or the schedule store again', () => {
    const found = files('packages', (p) => GUARDED.test(p) && !p.endsWith('.test.ts')).flatMap((f) =>
      matches(read(f), SECOND_COPY).map((m) => `${f}:${m}`),
    );
    assert.deepEqual(found, [], 'the cron rule and the schedule store are the Timekeeper\'s: import them from @beercanlabs/factory-timekeeper');
  });

  it('only the control plane\'s composition root starts the Timekeeper\'s clock', () => {
    const found = files('packages', (p) => /^packages\/[^/]+\/src\/.*\.ts$/.test(p) && !p.endsWith('.test.ts') && p !== CLOCK_OWNER).flatMap((f) =>
      matches(read(f), [CLOCK_START]).map((m) => `${f}:${m}`),
    );
    assert.deepEqual(found, [], `a second scheduler loop: only ${CLOCK_OWNER} calls createTimekeeper`);
    assert.ok(CLOCK_START.test(read(CLOCK_OWNER)), `${CLOCK_OWNER} no longer starts the Timekeeper, so nothing fires what is due`);
  });

  it('packages/timekeeper does not depend on control-plane, a gatekeeper or the console', () => {
    const pkg = JSON.parse(read('packages/timekeeper/package.json')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    const back = names.filter((n) => /^@beercanlabs\/factory-(control-plane|gatekeeper-.+|console)$/.test(n));
    assert.deepEqual(back, [], 'the dependency points one way: the control plane depends on the Timekeeper');
  });
});
