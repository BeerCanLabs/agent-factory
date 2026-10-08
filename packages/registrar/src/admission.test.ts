// TSK-129 (GAP-098, §6.8 L3, L4): the admission decision, as the deploy route made it before the move. The control
// plane's admission.e2e.test.ts covers the route and is the guard for the wiring.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { admissionOf, admit, beginAdmission, pinSource, stateAfterRefusal, type AdmissionSource } from './admission.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const REPO = 'https://github.com/x/ada';

describe('L3 L4 pinning the source to admit', () => {
  it('uses the agent’s registered repository and commit when the request names none', () => {
    assert.deepEqual(pinSource({ repo: REPO, commit: SHA }), { ok: true, source: { repo: REPO, commit: SHA } });
    assert.deepEqual(pinSource({ repo: REPO, commit: SHA }, {}), { ok: true, source: { repo: REPO, commit: SHA } });
  });

  it('a request may re-pin the commit, the repository, or both', () => {
    assert.deepEqual(pinSource({ repo: REPO, commit: SHA }, { commit: OTHER }), { ok: true, source: { repo: REPO, commit: OTHER } });
    assert.deepEqual(pinSource({ repo: REPO, commit: SHA }, { repo: 'https://github.com/y/ada' }), {
      ok: true,
      source: { repo: 'https://github.com/y/ada', commit: SHA },
    });
    assert.deepEqual(pinSource({}, { repo: REPO, commit: OTHER }), { ok: true, source: { repo: REPO, commit: OTHER } });
  });

  it('refuses a repository that is not a plain https URL without credentials', () => {
    for (const repo of ['http://github.com/x/ada', 'https://user:pw@github.com/x/ada', 'git@github.com:x/ada', '', 42]) {
      const r = pinSource({ repo: REPO, commit: SHA }, { repo });
      assert.equal(r.ok, false, String(repo));
      assert.equal((r as { error: string }).error, 'invalid_repo');
    }
  });

  it('refuses a commit that is not a full lowercase SHA: a short one, a branch, a tag, uppercase, a non-string', () => {
    for (const commit of ['abc1234', 'main', 'v1.2.0', SHA.toUpperCase(), 'a'.repeat(39), 42, null]) {
      const r = pinSource({ repo: REPO, commit: SHA }, { commit });
      assert.equal(r.ok, false, String(commit));
      assert.equal((r as { error: string }).error, 'invalid_commit');
    }
  });

  it('refuses an agent with no pinned source rather than building from a mutable ref', () => {
    for (const agent of [{}, { repo: REPO }, { commit: SHA }, { repo: REPO, commit: 'main' }]) {
      const r = pinSource(agent);
      assert.equal(r.ok, false);
      assert.equal((r as { error: string }).error, 'commit_required');
      assert.match((r as { message: string }).message, /deploys only a pinned, admitted commit/);
    }
  });

  it('reports a bad repository before a bad commit', () => {
    const r = pinSource({ repo: REPO, commit: SHA }, { repo: 'http://x/y', commit: 'main' });
    assert.equal((r as { error: string }).error, 'invalid_repo');
  });
});

describe('admission outcome', () => {
  const source: AdmissionSource = { repo: REPO, commit: SHA };
  class Refused extends Error {
    constructor(readonly reason: string, message: string, readonly phase?: string) {
      super(message);
    }
  }
  const isRefusal = (err: unknown): err is { reason: string; phase?: string } => err instanceof Refused;

  it('builds exactly the pinned source, once, and returns the image', async () => {
    const seen: AdmissionSource[] = [];
    const out = await admit(source, { build: async (s) => (seen.push(s), 'registry/ada:aaaaaaaaaaaa') });
    assert.deepEqual(out, { status: 'admitted', commit: SHA, imageUri: 'registry/ada:aaaaaaaaaaaa' });
    assert.deepEqual(seen, [source]);
  });

  it('a refusal that names its reason keeps the reason and the phase', async () => {
    const out = await admit(source, {
      build: async () => {
        throw new Refused('tests_failed', 'CodeBuild FAILED in BUILD', 'BUILD');
      },
      isRefusal,
    });
    assert.deepEqual(out, { status: 'refused', commit: SHA, reason: 'tests_failed', phase: 'BUILD', message: 'CodeBuild FAILED in BUILD' });
  });

  it('any other failure is build_failed, with no phase', async () => {
    const out = await admit(source, {
      build: async () => {
        throw new Error('socket hang up');
      },
      isRefusal,
    });
    assert.deepEqual(out, { status: 'refused', commit: SHA, reason: 'build_failed', phase: undefined, message: 'socket hang up' });
    const bare = await admit(source, {
      build: async () => {
        throw new Refused('no_tests', 'no tests');
      },
    });
    assert.equal((bare as { reason: string }).reason, 'build_failed', 'without isRefusal nothing is trusted to name a reason');
  });

  it('S1 a secret value is removed from the message before it is kept', async () => {
    const out = await admit(source, {
      build: async () => {
        throw new Error('push to registry with token sk-live-123 failed');
      },
      redact: (m) => m.replaceAll('sk-live-123', '[redacted]'),
    });
    assert.equal((out as { message: string }).message, 'push to registry with token [redacted] failed');
  });

  it('a thrown value that is not an Error is still reported', async () => {
    const out = await admit(source, {
      build: async () => {
        throw 'plain string';
      },
    });
    assert.equal((out as { message: string }).message, 'plain string');
  });

  it('does not need an agent record: it only builds and reports', async () => {
    const out = await admit({ repo: REPO, commit: OTHER }, { build: async () => 'img' });
    assert.equal(out.status, 'admitted');
    assert.equal(out.commit, OTHER);
  });
});

describe('admission record and where a refused agent goes back to', () => {
  const when = new Date('2026-10-08T12:00:00.000Z');

  it('records an admission that has started, and its two endings', () => {
    assert.deepEqual(beginAdmission(SHA, when), { commit: SHA, status: 'building', at: '2026-10-08T12:00:00.000Z' });
    assert.deepEqual(admissionOf({ status: 'admitted', commit: SHA, imageUri: 'img' }, when), { commit: SHA, status: 'admitted', at: '2026-10-08T12:00:00.000Z' });
    assert.deepEqual(admissionOf({ status: 'refused', commit: SHA, reason: 'no_tests', phase: 'BUILD', message: 'm' }, when), {
      commit: SHA,
      status: 'refused',
      reason: 'no_tests',
      phase: 'BUILD',
      message: 'm',
      at: '2026-10-08T12:00:00.000Z',
    });
  });

  it('a refused new version leaves the running version in place; an agent never deployed is in error', () => {
    assert.equal(stateAfterRefusal({ deployedCommit: SHA }, 'RUNNING'), 'RUNNING');
    assert.equal(stateAfterRefusal({ deployedCommit: SHA }, 'SLEEPING'), 'SLEEPING');
    assert.equal(stateAfterRefusal({ deployedCommit: SHA }, 'PAUSED'), 'PAUSED');
    assert.equal(stateAfterRefusal({ deployedCommit: SHA }, 'ERROR'), 'SLEEPING', 'a deployed agent that was in error returns to service');
    assert.equal(stateAfterRefusal({}, 'PENDING_DEPLOY'), 'ERROR');
    assert.equal(stateAfterRefusal({}, 'ERROR'), 'ERROR');
  });
});
