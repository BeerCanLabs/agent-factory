// DESIGN_AUTHORITY.md §6.18 RT1 and RT2: the shared agent runtime is one fixed program with no extension points.
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { files, read, repoRoot } from './support.js';

const RUNTIME = 'runtimes/agent-runtime';
const sources = () => files(`${RUNTIME}/runtime`, (p) => p.endsWith('.py'));

describe('RT1 one shared runtime runs the loop for an agent from its configuration', () => {
  it('its own tests pass: a configuration alone answers a message, by archetype, with adopted skills, replying where the turn came from', () => {
    const run = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: join(repoRoot, RUNTIME), encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`.slice(-3000));
  });

  it('RT1 reads its soul, memory and skills from the factory, never from a file the agent ships', () => {
    const loop = read(`${RUNTIME}/runtime/loop.py`);
    assert.match(loop, /factory\.config\(\)/);
    const factory = read(`${RUNTIME}/runtime/factory.py`);
    assert.match(factory, /\/agent-config/);
    assert.ok(!sources().some((f) => /cartridge\.yaml|soul\.md/i.test(read(f))), 'no cartridge or soul file is read');
  });

  it('RT1 calls models only through the factory model API: no provider or cloud SDK in the runtime', () => {
    const sdk = /^\s*(?:import|from)\s+(?:boto3|botocore|aiobotocore|anthropic|openai|xai|xai_sdk|vertexai|google\.cloud|google\.genai|google\.generativeai)\b/m;
    assert.deepEqual(sources().filter((f) => sdk.test(read(f))), []);
    assert.equal(read(`${RUNTIME}/requirements.txt`).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length, 0, 'no third-party dependency');
  });
});

describe('RT2 the loop has no extension points', () => {
  it('RT2 only the skill loader loads code, and only from the folder of a skill the factory listed', () => {
    const dynamic = /\b(?:__import__|import_module|exec|eval|entry_points|pkg_resources|runpy)\s*\(|\bentry_points\b/;
    assert.deepEqual(sources().filter((f) => !f.endsWith('/skills.py') && (dynamic.test(read(f)) || /\bimportlib\b/.test(read(f)))), [], 'only skills.py may load code');
    const skills = read(`${RUNTIME}/runtime/skills.py`);
    assert.ok(!dynamic.test(skills), 'the skill loader uses no eval, exec or import_module');
    assert.match(skills, /folder\.resolve\(\) not in target\.parents/, 'a skill entry cannot leave its folder');
  });

  it('RT2 no environment variable or file names code to run: the runtime reads a fixed list of variables', () => {
    const allowed = new Set([
      'FACTORY_URL', 'FACTORY_RUN_ID', 'FACTORY_RUN_TOKEN', 'FACTORY_MODEL_BASE_URL', 'FACTORY_MODEL', 'DISCORD_BASE_URL',
      'FACTORY_RESULT_FILE', 'MEMORY_DIR', 'SKILLS_DIR',
    ]);
    const used = new Set<string>();
    for (const f of sources()) {
      for (const m of read(f).matchAll(/(?:os\.environ(?:\.get)?|env\.get)\(\s*["']([A-Z_]+)["']/g)) used.add(m[1]);
      for (const m of read(f).matchAll(/os\.environ\[\s*["']([A-Z_]+)["']\s*\]/g)) used.add(m[1]);
    }
    assert.deepEqual([...used].filter((v) => !allowed.has(v)), []);
    assert.ok(![...used].some((v) => /PLUGIN|HOOK|EXTENSION|MODULE|ENTRY/.test(v)));
  });

  it('RT2 skills are Python only, stated as the current implementation', () => {
    const doc = read('docs/SKILLS.md');
    assert.match(doc, /Skills are Python only/);
    assert.match(doc, /current implementation/);
  });
});
