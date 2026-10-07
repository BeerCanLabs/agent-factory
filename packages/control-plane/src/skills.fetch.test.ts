// TSK-055: registering a skill without a pasted manifest (DESIGN_AUTHORITY.md §6.14 SK1). The control plane reads
// `skill.yaml` at the pinned path and commit itself; a branch or tag is resolved to the full SHA it points at and the
// version is recorded at that SHA, so the pin never moves. Every failure is a 422 with a reason the caller can act on.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';
import { loadSkills, skillRegistry } from './skills.js';
import { checkRefName, gitSkillSource, gitTokenEnv, SourceError, type SkillSource } from '@beercanlabs/factory-registrar';

const USER = 'user-fetch-token';
const REPO = 'https://github.com/BeerCanLabs/skills';
const PRIVATE = 'https://github.com/BeerCanLabs/private-skills';
const MAIN = '1'.repeat(40);
const TAGGED = '2'.repeat(40);
const OLD = '3'.repeat(40);

const yaml = (id: string, version: string, extra = '') => `# a comment the parser ignores
id: ${id}
version: ${version}
name: ${id}
description: Fetched by the factory.
language: python
entry: ${id.replace(/-/g, '_')}/main.py
requires:
  routes: [discord]
${extra}`;

/** A repository in memory: refs and files per commit. `calls` records every read. */
function fakeSource(): SkillSource & { calls: string[] } {
  const refs: Record<string, string> = { main: MAIN, 'v1.0.0': TAGGED };
  const files: Record<string, Record<string, string>> = {
    [MAIN]: {
      'skills/notes/skill.yaml': yaml('fetched-notes', '1.0.0'),
      'skills/broken/skill.yaml': 'id: [unclosed',
      'skills/list/skill.yaml': '- just\n- a list\n',
      'skills/bad-id/skill.yaml': yaml('Not_Kebab', '1.0.0'),
      'skill.yaml': yaml('fetched-root', '1.0.0'),
    },
    [TAGGED]: { 'skills/notes/skill.yaml': yaml('fetched-notes', '1.1.0') },
    [OLD]: { 'skills/notes/skill.yaml': yaml('fetched-notes', '0.9.0') },
  };
  const calls: string[] = [];
  return {
    calls,
    async resolveRef(repo, ref) {
      calls.push(`resolve ${repo} ${ref}`);
      if (repo === PRIVATE) throw new SourceError('unreachable', `cannot read ${repo}`);
      return refs[ref];
    },
    async readFile(repo, commit, file) {
      calls.push(`read ${repo} ${commit} ${file}`);
      if (repo === PRIVATE) throw new SourceError('unreachable', `cannot read ${repo}`);
      if (!files[commit]) throw new SourceError('no_commit', `${repo} has no commit ${commit} (is it pushed?)`);
      return files[commit][file];
    },
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('TSK-055 SK1 registration reads skill.yaml at the pin when no manifest is sent', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  let source: ReturnType<typeof fakeSource>;

  const register = async (body: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/registry/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${USER}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-skills-fetch-'));
    ledger = new MemoryLedger();
    source = fakeSource();
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger,
      auth: bearerAuth([{ name: 'user', token: USER, roles: ['viewer'] }]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      gatekeeperEgressHeldSecrets: new Set(['ANTHROPIC_API_KEY']),
      skillChecker: null,
      skillSource: source,
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowHosts: [] } as unknown as FactoryState['callbacks'],
      runTokens: { issue: async () => '', verify: async () => undefined } as unknown as FactoryState['runTokens'],
      secretValues: new Set(),
    } as FactoryState;
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a full SHA without a manifest: the factory reads <path>/skill.yaml at that commit and registers it', async () => {
    const reg = await register({ repo: REPO, path: 'skills/notes', commit: OLD });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.id, 'fetched-notes');
    assert.equal(reg.body.version, '0.9.0');
    assert.equal(reg.body.commit, OLD);
    assert.equal(reg.body.path, 'skills/notes');
    assert.equal(reg.body.status, 'pending');
    assert.equal(reg.body.resolvedFrom, undefined);
    assert.deepEqual(reg.body.manifest.requires.routes, ['discord']);
    assert.ok(source.calls.includes(`read ${REPO} ${OLD} skills/notes/skill.yaml`));
    assert.ok(!source.calls.some((c) => c.startsWith('resolve')), 'a full SHA is never resolved');
  });

  it('a branch is resolved server-side to a full SHA and the version is recorded at that SHA', async () => {
    const reg = await register({ repo: REPO, path: './skills/notes/', commit: 'main' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.version, '1.0.0');
    assert.equal(reg.body.commit, MAIN, 'pinned to the SHA the branch pointed at');
    assert.equal(reg.body.resolvedFrom, 'main');
    const stored = skillRegistry(state).get('fetched-notes', '1.0.0');
    assert.equal(stored?.commit, MAIN);
    assert.equal((stored as Record<string, unknown>).resolvedFrom, undefined, 'only the SHA is recorded');
    const row = ledger.query().find((e) => e.action === 'SKILL_REGISTERED' && e.agentId === 'skill:fetched-notes@1.0.0');
    assert.equal(row?.commit, MAIN);
    assert.equal(row?.actor, 'token:user');
  });

  it('a tag (also given as refs/tags/...) is resolved to its commit', async () => {
    const reg = await register({ repo: REPO, path: 'skills/notes', commit: 'refs/tags/v1.0.0' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.version, '1.1.0');
    assert.equal(reg.body.commit, TAGGED);
    assert.equal(reg.body.resolvedFrom, 'v1.0.0');
  });

  it('the repository root is path "."', async () => {
    const reg = await register({ repo: REPO, commit: MAIN });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.id, 'fetched-root');
    assert.equal(reg.body.path, '.');
    assert.ok(source.calls.includes(`read ${REPO} ${MAIN} skill.yaml`));
  });

  it('no skill.yaml at that path: 422 that says so, and the refusal is ledgered', async () => {
    const reg = await register({ repo: REPO, path: 'skills/missing', commit: 'main' });
    assert.equal(reg.status, 422);
    assert.equal(reg.body.error, 'skill_refused');
    assert.ok(reg.body.reasons.some((r: string) => /no skill\.yaml at "skills\/missing"/.test(r)), JSON.stringify(reg.body));
    const row = ledger.query().filter((e) => e.action === 'SKILL_REFUSED').at(-1);
    assert.equal(row?.commit, MAIN, 'the refusal names the resolved commit');
  });

  it('a repository the factory cannot read: 422 that points at the source token', async () => {
    const reg = await register({ repo: PRIVATE, path: '.', commit: 'main' });
    assert.equal(reg.status, 422);
    assert.ok(reg.body.reasons.some((r: string) => /cannot fetch .*source token/.test(r)), JSON.stringify(reg.body));
    const sha = await register({ repo: PRIVATE, path: '.', commit: MAIN });
    assert.equal(sha.status, 422);
    assert.ok(sha.body.reasons.some((r: string) => /source token/.test(r)));
  });

  it('an unknown branch or commit: 422 with the reason', async () => {
    const branch = await register({ repo: REPO, path: 'skills/notes', commit: 'no-such-branch' });
    assert.equal(branch.status, 422);
    assert.ok(branch.body.reasons.some((r: string) => /no branch or tag named "no-such-branch"/.test(r)));
    const commit = await register({ repo: REPO, path: 'skills/notes', commit: 'f'.repeat(40) });
    assert.equal(commit.status, 422);
    assert.ok(commit.body.reasons.some((r: string) => /has no commit/.test(r)));
  });

  it('a commit that is neither a SHA nor a safe ref name is refused before anything is fetched', async () => {
    const before = source.calls.length;
    for (const commit of ['--upload-pack=x', '../main', 'main..dev', '', 42]) {
      const reg = await register({ repo: REPO, path: 'skills/notes', commit });
      assert.equal(reg.status, 422, String(commit));
      assert.ok(reg.body.reasons.some((r: string) => /^commit:/.test(r)));
    }
    assert.equal(source.calls.length, before);
  });

  it('pinning stays mandatory when a manifest is sent: a branch is refused, never resolved', async () => {
    const reg = await register({
      repo: REPO,
      path: 'skills/notes',
      commit: 'main',
      manifest: { id: 'fetched-notes', version: '9.0.0', name: 'n', description: 'd', language: 'python', entry: 'x.py' },
    });
    assert.equal(reg.status, 422);
    assert.ok(reg.body.reasons.some((r: string) => /full 40-character/.test(r)));
  });

  it('a fetched skill.yaml is admitted like a sent one: invalid YAML, a non-mapping or a bad manifest is refused', async () => {
    const broken = await register({ repo: REPO, path: 'skills/broken', commit: MAIN });
    assert.equal(broken.status, 422);
    assert.ok(broken.body.reasons.some((r: string) => /not valid YAML/.test(r)), JSON.stringify(broken.body));
    const list = await register({ repo: REPO, path: 'skills/list', commit: MAIN });
    assert.equal(list.status, 422);
    assert.ok(list.body.reasons.some((r: string) => /not a mapping/.test(r)));
    const bad = await register({ repo: REPO, path: 'skills/bad-id', commit: MAIN });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.reasons.some((r: string) => /manifest\.id/.test(r)));
  });
});

describe('TSK-055 gitSkillSource reads a real git repository', () => {
  let dir: string;
  let repo: string;
  let head: string;
  let tagged: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
    }).trim();

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-skill-source-'));
    const work = join(dir, 'work');
    mkdirSync(join(work, 'skills', 'notes'), { recursive: true });
    git(work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'skills', 'notes', 'skill.yaml'), 'id: notes\nversion: 1.0.0\n');
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'one');
    tagged = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', '-a', 'v1.0.0', '-m', 'annotated');
    writeFileSync(join(work, 'skills', 'notes', 'skill.yaml'), 'id: notes\nversion: 1.1.0\n');
    git(work, 'commit', '-q', '-am', 'two');
    head = git(work, 'rev-parse', 'HEAD');
    git(dir, 'clone', '-q', '--bare', work, 'repo.git');
    repo = `file://${join(dir, 'repo.git')}`;
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves a branch and an annotated tag to commits, and reads a file at a commit', async () => {
    const source = gitSkillSource({ token: () => undefined });
    assert.equal(await source.resolveRef(repo, 'main'), head);
    assert.equal(await source.resolveRef(repo, 'v1.0.0'), tagged, 'an annotated tag resolves to its commit, not the tag object');
    assert.equal(await source.resolveRef(repo, 'nope'), undefined);
    assert.equal(await source.readFile(repo, head, 'skills/notes/skill.yaml'), 'id: notes\nversion: 1.1.0\n');
    assert.equal(await source.readFile(repo, tagged, 'skills/notes/skill.yaml'), 'id: notes\nversion: 1.0.0\n');
  });

  it('a missing file is undefined; a missing commit or repository is a SourceError that says which', async () => {
    const source = gitSkillSource({ token: () => undefined });
    assert.equal(await source.readFile(repo, head, 'skill.yaml'), undefined);
    assert.equal(await source.readFile(repo, head, 'skills/notes'), undefined, 'a folder is not a file');
    await assert.rejects(source.readFile(repo, 'e'.repeat(40), 'skill.yaml'), (e: unknown) => e instanceof SourceError && e.kind === 'no_commit');
    await assert.rejects(source.readFile(`file://${join(dir, 'nope.git')}`, head, 'skill.yaml'), (e: unknown) => e instanceof SourceError && e.kind === 'unreachable');
  });

  it('the source token goes only to its own hosts, over https, scoped to that origin', () => {
    const env = gitTokenEnv('https://github.com/BeerCanLabs/x', 'tok', ['github.com']);
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraHeader');
    assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('x-access-token:tok').toString('base64')}`);
    assert.deepEqual(gitTokenEnv('https://evil.example/BeerCanLabs/x', 'tok', ['github.com']), {}, 'never to a host a caller typed');
    assert.deepEqual(gitTokenEnv('https://github.com.evil.example/x', 'tok', ['github.com']), {});
    assert.deepEqual(gitTokenEnv('https://github.com:8443/x', 'tok', ['github.com']), {});
    assert.deepEqual(gitTokenEnv('http://github.com/x', 'tok', ['github.com']), {}, 'never in clear text');
    assert.deepEqual(gitTokenEnv('https://github.com/x', undefined, ['github.com']), {});
  });

  it('ref names: branches and tags pass; options, traversal and ref-log syntax do not', () => {
    for (const ok of ['main', 'release/1.2', 'v1.0.0', 'refs/heads/main', 'feat_x-y']) assert.ok(checkRefName(ok), ok);
    for (const bad of ['-x', '--upload-pack=x', '../x', 'a..b', 'a//b', '/a', 'a/', 'a.lock', 'main@{1}', 'a b', '', 'x'.repeat(201), 7]) {
      assert.equal(checkRefName(bad), undefined, String(bad));
    }
  });
});
