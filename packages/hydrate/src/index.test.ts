import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullMind, pushMind } from './index.js';

describe('hydrate', () => {
  it('rehydrates after ephemeral disk is destroyed', () => {
    const root = mkdtempSync(join(tmpdir(), 'mind-'));
    const store = { root: join(root, 'object') };
    const ephemeral = join(root, 'ephemeral');
    mkdirSync(ephemeral, { recursive: true });
    writeFileSync(join(ephemeral, 'note.md'), 'remembered');
    pushMind(store, 'echo-agent', ephemeral);
    rmSync(ephemeral, { recursive: true, force: true });
    pullMind(store, 'echo-agent', ephemeral);
    assert.equal(readFileSync(join(ephemeral, 'note.md'), 'utf8'), 'remembered');
    rmSync(root, { recursive: true });
  });

  it('invokes gcloud storage rsync for gcs:// and gs:// stores', () => {
    const executed: Array<{ cmd: string; args: string[] }> = [];
    const syncMock = (cmd: string, args: string[]) => {
      executed.push({ cmd, args });
    };

    const gcsStore = { root: '/tmp', uri: 'gcs://my-bucket' };
    pullMind(gcsStore, 'test-agent', '/tmp/dest', syncMock);
    assert.deepEqual(executed[0], {
      cmd: 'gcloud',
      args: ['storage', 'rsync', '-r', 'gs://my-bucket/test-agent', '/tmp/dest'],
    });

    const root = mkdtempSync(join(tmpdir(), 'gcs-push-'));
    writeFileSync(join(root, 'state.json'), '{}');
    pushMind(gcsStore, 'test-agent', root, syncMock);
    assert.deepEqual(executed[1], {
      cmd: 'gcloud',
      args: ['storage', 'rsync', '-r', root, 'gs://my-bucket/test-agent'],
    });
    rmSync(root, { recursive: true });
  });
});

