import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScheduleStore, createTimekeeper, type FireRequest, type ScheduledAction } from './index.js';

const at = new Date('2026-09-22T19:00:00Z'); // 15:00 in New York (EDT), 12:00 in Los Angeles (PDT)

const schedule = (over: Partial<ScheduledAction>): ScheduledAction => ({
  id: 's1',
  agentId: 'rosie',
  name: 'noon',
  cron: '0 15 * * *',
  timezone: 'America/New_York',
  prompt: 'p',
  enabled: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

// The cartridge cron reads a Date in the process's local time, so build the agent's cron from `at` itself.
const localCron = `${at.getMinutes()} ${at.getHours()} * * *`;
const agents = [
  { id: 'matching', triggers: [{ type: 'cron', schedule: localCron }] },
  { id: 'elsewhere', triggers: [{ type: 'cron', schedule: `${(at.getMinutes() + 1) % 60} * * * *` }] },
  { id: 'http-only', triggers: [{ type: 'http', path: '/x' }] },
];

function setup(options: { fire?: (r: FireRequest) => void | Promise<void> } = {}) {
  const fired: FireRequest[] = [];
  const store = new ScheduleStore();
  const timekeeper = createTimekeeper({
    agents: () => agents,
    schedules: store,
    now: () => at,
    fire: async (request) => {
      fired.push(request);
      await options.fire?.(request);
    },
  });
  return { fired, store, timekeeper };
}

describe('createTimekeeper', () => {
  it('fires a matching cartridge cron once, and not an agent whose cron or trigger does not match', async () => {
    const { fired, timekeeper } = setup();
    await timekeeper.tick();
    assert.deepEqual(fired, [{ kind: 'cartridge', agentId: 'matching' }]);
  });

  it('fires a due schedule once and not again that minute', async () => {
    const { fired, store, timekeeper } = setup();
    store.save(schedule({}));
    await timekeeper.tick();
    const schedules = fired.filter((r) => r.kind === 'schedule');
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].kind === 'schedule' && schedules[0].schedule.id, 's1');
    await timekeeper.tick();
    assert.equal(fired.filter((r) => r.kind === 'schedule').length, 1);
  });

  it('does not fire a disabled schedule or one that is not due in its own time zone', async () => {
    const { fired, store, timekeeper } = setup();
    store.save(schedule({ id: 'off', enabled: false }));
    store.save(schedule({ id: 'la', timezone: 'America/Los_Angeles' })); // 12:00 there
    await timekeeper.tick();
    assert.deepEqual(fired.filter((r) => r.kind === 'schedule'), []);
  });

  it('one failing fire, thrown or rejected, does not stop the others', async () => {
    for (const failure of ['throw', 'reject'] as const) {
      const { fired, store, timekeeper } = setup({
        fire: (r) => {
          if (r.kind !== 'cartridge') return;
          if (failure === 'throw') throw new Error('boom');
          return Promise.reject(new Error('boom'));
        },
      });
      store.save(schedule({}));
      const warn = console.warn;
      console.warn = () => {};
      try {
        await timekeeper.tick();
      } finally {
        console.warn = warn;
      }
      assert.deepEqual(fired.map((r) => r.kind), ['cartridge', 'schedule'], failure);
    }
  });

  it('start runs tick on the interval and returns a function that stops it', async () => {
    const { fired, timekeeper } = setup();
    const stop = timekeeper.start(5);
    await new Promise((resolve) => setTimeout(resolve, 40));
    stop();
    const count = fired.length;
    assert.ok(count >= 1, 'tick ran at least once');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(fired.length, count, 'no tick after stop');
  });
});
