// TSK-159 (DESIGN_AUTHORITY.md §6.14 SK4): the script the admission build runs to put an agent's adopted skills in its
// image. It runs for real here, against local git repositories reached through git's own URL rewriting, so the script
// has no test-only switch: what is tested is what CodeBuild runs.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'landing-zones', 'aws', 'compose-skills.sh');
const HOST = 'git.example.test';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

function skillYaml(id: string, version: string): string {
  return `id: ${id}\nversion: ${version}\nname: ${id}\ndescription: A skill.\nlanguage: python\nentry: ${id.replace(/-/g, '_')}\nrequires:\n  routes: [tavily]\n`;
}

describe('composing adopted skills into a build context (SK4)', () => {
  let root: string;
  let repos: string;
  let pins: Record<string, { repo: string; path: string; commit: string }>;

  /** A repository at `<repos>/<name>.git` reached as https://git.example.test/<name>. Returns its first commit. */
  function makeRepo(name: string, files: Record<string, string>): string {
    const dir = join(root, 'src', name);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    for (const [file, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), body);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    execFileSync('git', ['clone', '-q', '--bare', dir, join(repos, `${name}.git`)]);
    return git(dir, 'rev-parse', 'HEAD');
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'compose-skills-'));
    repos = join(root, 'repos');
    mkdirSync(repos, { recursive: true });
    const tavily = makeRepo('skill-tavily-search', { 'skill.yaml': skillYaml('tavily-search', '0.1.0'), 'tavily_search/__init__.py': 'def search(q):\n    return q\n', 'README.md': '# t\n' });
    const mono = makeRepo('skills-mono', { 'print/skill.yaml': skillYaml('print', '0.1.1'), 'print/print_api.py': 'X = 1\n', 'other/skill.yaml': skillYaml('other', '9.9.9') });
    const leaky = makeRepo('skill-leaky', { 'skill.yaml': skillYaml('leaky', '1.0.0'), 'leaky/__init__.py': 'API_TOKEN = "Zk3mPq9xLw2RtYh7VbN5cJd8Fg4Ss1Aa"\n' });
    pins = {
      tavily: { repo: `https://${HOST}/skill-tavily-search`, path: '.', commit: tavily },
      print: { repo: `https://${HOST}/skills-mono`, path: 'print', commit: mono },
      leaky: { repo: `https://${HOST}/skill-leaky`, path: '.', commit: leaky },
    };
    // A later commit on tavily's main that the pin must not pick up.
    const work = join(root, 'src', 'skill-tavily-search');
    writeFileSync(join(work, 'tavily_search', '__init__.py'), 'def search(q):\n    return "newer"\n');
    git(work, 'commit', '-q', '-am', 'later');
    git(work, 'push', '-q', join(repos, 'skill-tavily-search.git'), 'main');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  /** Runs the script in a fresh directory with git redirected to the local repositories. */
  function compose(skills: unknown, extraEnv: Record<string, string> = {}) {
    const cwd = mkdtempSync(join(root, 'run-'));
    const r = spawnSync('bash', [SCRIPT], {
      cwd,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: cwd,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file://${repos}/.insteadOf`,
        GIT_CONFIG_VALUE_0: `https://${HOST}/`,
        SKILLS: typeof skills === 'string' ? skills : JSON.stringify(skills),
        ...extraEnv,
      },
    });
    return { cwd, status: r.status, out: `${r.stdout}${r.stderr}`, dir: join(cwd, '.factory-skills') };
  }
  const pin = (key: keyof typeof pins, id: string, version: string) => ({ id, version, ...pins[key] });

  it('puts each skill at exactly its pinned commit in the context, without .git, and lists them in the manifest', () => {
    const r = compose([pin('tavily', 'tavily-search', '0.1.0'), pin('print', 'print', '0.1.1')]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readdirSync(join(r.dir, 'skills')).sort(), ['print', 'tavily-search']);
    assert.match(readFileSync(join(r.dir, 'skills', 'tavily-search', 'tavily_search', '__init__.py'), 'utf8'), /return q/, 'the pinned commit, not the later one');
    assert.ok(existsSync(join(r.dir, 'skills', 'print', 'print_api.py')), 'only the skill’s folder of a monorepo');
    assert.ok(!existsSync(join(r.dir, 'skills', 'print', 'other')) && !existsSync(join(r.dir, 'skills', 'other')));
    assert.ok(!existsSync(join(r.dir, 'skills', 'tavily-search', '.git')));
    assert.deepEqual(JSON.parse(readFileSync(join(r.dir, 'skills.json'), 'utf8')), {
      skills: [
        { id: 'print', version: '0.1.1', language: 'python', entry: 'print', path: '/opt/factory/skills/print' },
        { id: 'tavily-search', version: '0.1.0', language: 'python', entry: 'tavily_search', path: '/opt/factory/skills/tavily-search' },
      ],
    });
    assert.equal(readFileSync(join(r.dir, 'Dockerfile'), 'utf8'), 'ARG BASE\nFROM ${BASE}\nCOPY skills /opt/factory/skills\nCOPY skills.json /opt/factory/skills.json\n');
  });

  it('refuses input that is not a list of well-formed pins (exit 5)', () => {
    const good = pin('tavily', 'tavily-search', '0.1.0');
    for (const bad of [
      '',
      'not json',
      [],
      {},
      [{ ...good, extra: 'x' }],
      [{ id: good.id }],
      [{ ...good, id: 'Bad Id' }],
      [{ ...good, version: 'latest' }],
      [{ ...good, commit: 'main' }],
      [{ ...good, repo: 'git@github.com:x/y.git' }],
      [{ ...good, repo: 'https://user:pw@git.example.test/skill-tavily-search' }],
      [{ ...good, repo: 'http://git.example.test/skill-tavily-search' }],
      [{ ...good, path: '../x' }],
      [{ ...good, path: '/etc' }],
      [good, good],
    ]) {
      const r = compose(bad);
      assert.equal(r.status, 5, `${JSON.stringify(bad)}: ${r.out}`);
      assert.ok(!existsSync(join(r.dir, 'Dockerfile')), 'nothing is composed from a refused pin');
    }
  });

  it('refuses a commit the repository does not have, and a repository that cannot be cloned', () => {
    assert.equal(compose([{ ...pin('tavily', 'tavily-search', '0.1.0'), commit: 'f'.repeat(40) }]).status, 5);
    assert.equal(compose([{ ...pin('tavily', 'tavily-search', '0.1.0'), repo: `https://${HOST}/no-such-repo` }]).status, 5);
  });

  it('refuses a folder whose skill.yaml is not the skill that was approved', () => {
    assert.equal(compose([pin('tavily', 'tavily-search', '0.2.0')]).status, 5, 'another version');
    assert.equal(compose([pin('tavily', 'something-else', '0.1.0')]).status, 5, 'another skill');
    assert.equal(compose([{ ...pin('print', 'print', '0.1.1'), path: 'other' }]).status, 5, 'another folder of the repository');
    assert.equal(compose([{ ...pin('print', 'print', '0.1.1'), path: 'missing' }]).status, 5, 'no such folder');
  });

  it('refuses a skill that hard-codes a credential, naming the file and line but never the value (exit 6)', () => {
    const r = compose([pin('leaky', 'leaky', '1.0.0')]);
    assert.equal(r.status, 6, r.out);
    assert.match(r.out, /hardcoded_secret/);
    assert.match(r.out, /leaky\/__init__\.py:1/);
    assert.ok(!r.out.includes('Zk3mPq9xLw2RtYh7VbN5cJd8Fg4Ss1Aa'), 'the value is never printed');
    assert.ok(!existsSync(join(r.dir, 'Dockerfile')));
  });

  it('never follows a folder that is a link out of the repository', () => {
    const dir = join(root, 'src', 'skill-linked');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'skill.yaml'), skillYaml('linked', '1.0.0'));
    writeFileSync(join(outside, 'host-file.txt'), 'must not be copied');
    symlinkSync(outside, join(dir, 'escape'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    execFileSync('git', ['clone', '-q', '--bare', dir, join(repos, 'skill-linked.git')]);
    const r = compose([{ id: 'linked', version: '1.0.0', repo: `https://${HOST}/skill-linked`, path: 'escape', commit: git(dir, 'rev-parse', 'HEAD') }]);
    assert.equal(r.status, 5, r.out);
    assert.match(r.out, /leaves the repository/);
    assert.ok(!existsSync(join(r.dir, 'skills', 'linked', 'host-file.txt')));
  });

  it('sends the source token only to an allowed source host', () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const calls = join(root, 'aws-calls');
    writeFileSync(join(bin, 'aws'), `#!/bin/sh\necho "$@" >> "${calls}"\necho test-token\n`);
    chmodSync(join(bin, 'aws'), 0o755);
    const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, GIT_TOKEN_SECRET_ID: 'arn:aws:secretsmanager:us-east-1:111111111111:secret:source-token' };
    const tavily = [pin('tavily', 'tavily-search', '0.1.0')];

    assert.equal(compose(tavily, { ...env, SOURCE_TOKEN_HOSTS: 'github.com' }).status, 0);
    assert.ok(!existsSync(calls), 'the token was not even read for a host that is not allowed');

    assert.equal(compose(tavily, { ...env, SOURCE_TOKEN_HOSTS: `github.com ${HOST}` }).status, 0);
    assert.match(readFileSync(calls, 'utf8'), /get-secret-value --secret-id arn:aws:secretsmanager/, 'read for an allowed host');
  });
});

describe('the admission buildspec that runs it (landing-zones/aws/codebuild.tf)', () => {
  const dir = join(dirname(SCRIPT));
  const tf = readFileSync(join(dir, 'codebuild.tf'), 'utf8');

  /** The buildspec as Terraform renders it: the heredoc, `indent(8, file(...))` filled in, `$${` turned into `${`. */
  function render(): { commands: Record<string, string[]>; script: string } {
    const heredoc = tf.match(/buildspec = <<EOF\n([\s\S]*?)\nEOF\n/)?.[1];
    assert.ok(heredoc, 'the factory-agent-builder buildspec is in codebuild.tf');
    const file = readFileSync(SCRIPT, 'utf8');
    const embedded = file.replace(/\n$/, '').split('\n').map((l, i) => (i === 0 ? l : l === '' ? '' : `        ${l}`)).join('\n');
    // Replacement functions, not strings: the script is full of `$'`, which String.replace would read as a pattern.
    const rendered = heredoc.replace('${indent(8, file("${path.module}/compose-skills.sh"))}', () => embedded).replaceAll('$${', () => '${');
    const spec = parseYaml(rendered) as { phases: Record<string, { commands: string[] }> };
    return { commands: Object.fromEntries(Object.entries(spec.phases).map(([k, v]) => [k, v.commands])), script: rendered };
  }

  it('is valid YAML and still has all four phases', () => {
    assert.deepEqual(Object.keys(render().commands), ['install', 'pre_build', 'build', 'post_build']);
  });

  it('writes exactly compose-skills.sh to disk when there are skills, and the script it writes passes bash -n', () => {
    const install = render().commands.install.find((c) => c.includes('FACTORY_COMPOSE_SKILLS'));
    assert.ok(install, 'the install phase writes the script');
    const work = mkdtempSync(join(root0(), 'buildspec-'));
    // Run the real command with /tmp redirected, SKILLS set: it must write the script byte for byte.
    const run = spawnSync('bash', ['-c', install.replaceAll('/tmp/compose-skills.sh', join(work, 'compose-skills.sh'))], { env: { PATH: process.env.PATH ?? '', SKILLS: '[{"x":1}]' }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(join(work, 'compose-skills.sh'), 'utf8'), readFileSync(SCRIPT, 'utf8'));
    assert.equal(spawnSync('bash', ['-n', join(work, 'compose-skills.sh')]).status, 0);
    // And writes nothing when the agent has no skills.
    const none = mkdtempSync(join(root0(), 'buildspec-'));
    spawnSync('bash', ['-c', install.replaceAll('/tmp/compose-skills.sh', join(none, 'compose-skills.sh'))], { env: { PATH: process.env.PATH ?? '', SKILLS: '' } });
    assert.ok(!existsSync(join(none, 'compose-skills.sh')));
  });

  /** Runs the tag guard (the install phase's first two commands) for a tag and SKILLS; true when it lets the build go on. */
  function tagAllowed(agentId: string, commit: string, tag: string, skills: string): boolean {
    const { install } = render().commands;
    const guard = install.slice(1, 3).join('\n');
    const r = spawnSync('bash', ['-c', guard], { env: { PATH: process.env.PATH ?? '', AGENT_ID: agentId, GIT_COMMIT: commit, IMAGE_TAG: tag, SKILLS: skills }, encoding: 'utf8' });
    return r.status === 0;
  }

  it('lets an agent without skills keep today’s tag, and only that tag', () => {
    const c = 'a'.repeat(40);
    assert.equal(tagAllowed('echo-agent', c, 'echo-agent-aaaaaaaaaaaa', ''), true);
    assert.equal(tagAllowed('echo-agent', c, 'echo-agent-aaaaaaaaaaaa-0123456789ab', ''), false, 'a skills tag without skills');
    assert.equal(tagAllowed('echo-agent', c, 'echo-agent-latest', ''), false);
    assert.equal(tagAllowed('echo-agent', 'main', 'echo-agent-main', ''), false, 'not a full SHA');
  });

  it('lets an agent with skills use the commit and a hash of the pins, and nothing else', () => {
    const c = 'b'.repeat(40);
    const skills = '[{"id":"x"}]';
    assert.equal(tagAllowed('higgins', c, 'higgins-bbbbbbbbbbbb-0123456789ab', skills), true);
    assert.equal(tagAllowed('higgins', c, 'higgins-bbbbbbbbbbbb', skills), false, 'skills need the hash');
    assert.equal(tagAllowed('higgins', c, 'higgins-bbbbbbbbbbbb-0123456789a', skills), false, 'too short');
    assert.equal(tagAllowed('higgins', c, 'higgins-bbbbbbbbbbbb-0123456789AB', skills), false, 'not lower-case hex');
    assert.equal(tagAllowed('higgins', c, 'other-bbbbbbbbbbbb-0123456789ab', skills), false, 'another agent’s tag');
    assert.equal(tagAllowed('hig.gins', c, 'higxgins-bbbbbbbbbbbb-0123456789ab', skills), false, 'a dot in the id is not a wildcard');
  });
});

function root0(): string {
  return tmpdir();
}
