import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleStore, type ScheduledAction } from './index.js';

// The bytes `ScheduleStore` writes today: a JSON array, two-space indent, no trailing newline, insertion order.
const FIXTURE = `[
  {
    "id": "sched-a",
    "agentId": "rosie",
    "name": "Noon check",
    "cron": "0 15 * * *",
    "timezone": "America/New_York",
    "channelId": "chan-1",
    "prompt": "check the litter",
    "enabled": true,
    "createdAt": "2026-09-01T00:00:00.000Z",
    "lastRunAt": "2026-09-21T19:00:00.000Z",
    "lastRunMinute": "2026-9-21 15:0"
  },
  {
    "id": "sched-b",
    "agentId": "finley",
    "name": "Paused report",
    "cron": "0 6 * * *",
    "prompt": "daily report",
    "enabled": false,
    "createdAt": "2026-09-02T00:00:00.000Z"
  }
]`;

const action = (over: Partial<ScheduledAction>): ScheduledAction => ({
  id: 'x',
  agentId: 'rosie',
  name: 'x',
  cron: '0 15 * * *',
  prompt: 'p',
  enabled: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('ScheduleStore file format', () => {
  it('loads a schedules.json written by the store and persists the same bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timekeeper-'));
    try {
      const path = join(dir, 'schedules.json');
      writeFileSync(path, FIXTURE, 'utf8');
      const store = new ScheduleStore(path);
      assert.deepEqual(store.list().map((s) => s.id), ['sched-a', 'sched-b']);
      assert.equal(store.get('sched-a')!.lastRunMinute, '2026-9-21 15:0');
      assert.equal(store.get('sched-b')!.enabled, false);
      store.save(store.get('sched-a')!);
      assert.equal(readFileSync(path, 'utf8'), FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the fixture bytes when the same two schedules are saved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timekeeper-'));
    try {
      const path = join(dir, 'nested', 'schedules.json');
      const store = new ScheduleStore(path);
      store.save(JSON.parse(FIXTURE)[0]);
      store.save(JSON.parse(FIXTURE)[1]);
      assert.equal(readFileSync(path, 'utf8'), FIXTURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ScheduleStore.checkDue', () => {
  const fixed = new Date('2026-09-22T19:00:00Z'); // 15:00 in New York (EDT), 12:00 in Los Angeles (PDT)

  it('returns the schedules due in their own time zone, marks the minute, and skips the same minute twice', () => {
    const store = new ScheduleStore();
    store.save(action({ id: 'ny', timezone: 'America/New_York' }));
    store.save(action({ id: 'la-default' })); // no timezone: Los Angeles, 12:00 here, so not due
    store.save(action({ id: 'off', timezone: 'America/New_York', enabled: false }));
    const first = store.checkDue(fixed);
    assert.deepEqual(first.map((s) => s.id), ['ny']);
    assert.equal(first[0].lastRunMinute, '2026-9-22 15:0');
    assert.equal(first[0].lastRunAt, fixed.toISOString());
    assert.equal(store.get('off')!.lastRunMinute, undefined);
    assert.deepEqual(store.checkDue(fixed), []);
    assert.deepEqual(store.checkDue(new Date(fixed.getTime() + 30_000)).map((s) => s.id), []);
  });

  it('persists lastRunMinute and lastRunAt when something fired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'timekeeper-'));
    try {
      const path = join(dir, 'schedules.json');
      const store = new ScheduleStore(path);
      store.save(action({ id: 'ny', timezone: 'America/New_York' }));
      store.checkDue(fixed);
      const reloaded = new ScheduleStore(path).get('ny')!;
      assert.equal(reloaded.lastRunMinute, '2026-9-22 15:0');
      assert.equal(reloaded.lastRunAt, fixed.toISOString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
