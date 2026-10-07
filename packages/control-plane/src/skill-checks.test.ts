// TSK-054: the factory's checks on a skill version's code (DESIGN_AUTHORITY.md §6.14 SK1; E1, E5, S1). The check script
// runs here on fixture skills built at test time (no fixture with a credential-shaped value is committed), and the
// CodeBuild project in landing-zones/aws/codebuild.tf must embed exactly the same script.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { Build } from '@aws-sdk/client-codebuild';
import type { SkillManifest } from '@beercanlabs/factory-contract';
import { SKILL_CHECK_SCRIPT, localSkillChecker, manifestB64, parseSkillCheckResult, skillCheckEnv, type SkillCheckOutcome } from '@beercanlabs/factory-registrar';
import { codeBuildSkillChecker, skillCheckOutcome } from './aws/codebuild.js';
import { skillCheckerFromEnv } from './skills.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const MANIFEST: SkillManifest = {
  id: 'discord-progress',
  version: '1.0.0',
  name: 'Discord progress',
  description: "Renders a run's progress events as one live status message.",
  language: 'python',
  entry: 'discord_progress/render.py',
  requires: { routes: ['discord'], connections: [], credentials: [{ name: 'DISCORD_BOT_TOKEN', source: 'discord' }], models: [] },
} as SkillManifest;

const SKILL_YAML = `# The registered manifest, written as an author would.
id: discord-progress
version: 1.0.0
name: Discord progress
description: Renders a run's progress events as one live status message.  # trailing comment
language: python
entry: discord_progress/render.py
requires:
  routes: [discord]
  credentials:
    - name: DISCORD_BOT_TOKEN
      source: discord
`;

const RENDER_PY = `"""Renders progress. The Discord API is documented at https://discord.com/developers/docs."""
import os

BASE = os.environ.get("DISCORD_BASE_URL", "http://localhost:8081/discord")


def render(events):
    return "\\n".join(e["route"] for e in events)
`;

const TEST_PY = `import unittest

from discord_progress.render import render

EXAMPLE = "https://discord.com/api/v10/channels/1/messages"


class RenderTest(unittest.TestCase):
    def test_render(self):
        self.assertEqual(render([{"route": "discord"}]), "discord")
`;

/** A clean python skill; `extra` adds or replaces files (null removes one). */
function skillFiles(extra: Record<string, string | null> = {}): Record<string, string> {
  const files: Record<string, string | null> = {
    'skill.yaml': SKILL_YAML,
    'discord_progress/__init__.py': '',
    'discord_progress/render.py': RENDER_PY,
    'tests/__init__.py': '',
    'tests/test_render.py': TEST_PY,
    'README.md': 'See https://github.com/BeerCanLabs/skill-discord-progress for details.\n',
    ...extra,
  };
  return Object.fromEntries(Object.entries(files).filter((e): e is [string, string] => e[1] !== null));
}

function writeSkill(dir: string, files: Record<string, string>): string {
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe('SK1 E1 E5 S1 the skill check script on fixture skills', { concurrency: false }, () => {
  let work: string;
  let script: string;

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'skill-check-script-'));
    script = join(work, 'skill_check.py');
    writeFileSync(script, SKILL_CHECK_SCRIPT);
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  function check(files: Record<string, string>, opts: { manifest?: SkillManifest; env?: Record<string, string> } = {}): SkillCheckOutcome & { raw: string; log: string } {
    const dir = writeSkill(join(work, 'skill'), files);
    const out = join(work, 'result.json');
    rmSync(out, { force: true });
    const r = spawnSync('python3', [script, '--dir', dir, '--manifest-b64', manifestB64(opts.manifest ?? MANIFEST), '--venv', join(work, 'venv'), '--out', out], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...opts.env },
    });
    assert.equal(r.status, 0, `the script itself must not crash: ${r.stderr}`);
    const raw = readFileSync(out, 'utf8');
    const last = r.stdout.trim().split('\n').at(-1) ?? '';
    assert.equal(last, `SKILL_CHECK_RESULT=${raw}`, 'the result line and the result file agree');
    return { ...parseSkillCheckResult(raw), raw, log: r.stdout };
  }

  it('the check runs on Python 3.11 or later', () => {
    const v = spawnSync('python3', ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' });
    assert.equal(v.stdout.trim(), 'True', 'python3 3.11+ is required to run the skill checks');
  });

  it('SK1 a clean python skill passes: its manifest matches and its unittest tests pass', () => {
    const res = check(skillFiles());
    assert.deepEqual({ passed: res.passed, failures: res.failures }, { passed: true, failures: [] }, res.log);
    assert.match(res.log, /Ran 1 test/);
  });

  it('SK1 the manifest comparison gives the same answer without PyYAML (stdlib only)', () => {
    assert.equal(check(skillFiles(), { env: { SKILL_CHECK_NO_PYYAML: '1' } }).passed, true);
    const changed = check(skillFiles({ 'skill.yaml': SKILL_YAML.replace('routes: [discord]', 'routes: [discord, github]') }), { env: { SKILL_CHECK_NO_PYYAML: '1' } });
    assert.deepEqual(changed.failures, ['manifest: skill.yaml at this commit does not match the registered manifest (requires.routes)']);
  });

  it('SK1 skill.yaml at the commit must match the registered manifest, and must exist', () => {
    const other = check(skillFiles({ 'skill.yaml': SKILL_YAML.replace('version: 1.0.0', 'version: 1.0.1') }));
    assert.equal(other.passed, false);
    assert.deepEqual(other.failures, ['manifest: skill.yaml at this commit does not match the registered manifest (version)']);
    const missing = check(skillFiles({ 'skill.yaml': null }));
    assert.deepEqual(missing.failures, ['manifest: no skill.yaml in the skill folder at this commit']);
  });

  it('E5 S1 a skill that imports a provider SDK, in any form, is refused', () => {
    const res = check(
      skillFiles({
        'discord_progress/llm.py': 'import boto3\nfrom google.cloud import storage\nimport importlib\nclient = importlib.import_module("openai")\n',
        'discord_progress/xai_call.py': 'from xai_sdk import Client\n',
      }),
    );
    assert.equal(res.passed, false);
    assert.deepEqual(res.failures.sort(), [
      'provider SDK: discord_progress/llm.py:1 imports boto3',
      'provider SDK: discord_progress/llm.py:2 imports google.cloud',
      'provider SDK: discord_progress/llm.py:4 imports openai',
      'provider SDK: discord_progress/xai_call.py:1 imports xai_sdk',
    ]);
  });

  it('E5 a provider SDK dependency in requirements*.txt or pyproject.toml is refused', () => {
    const res = check(
      skillFiles({
        'requirements.txt': '# runtime\nrequests==2.32.0\nanthropic>=0.30  # model calls\n',
        'requirements-dev.txt': 'botocore\n',
        'pyproject.toml': '[project]\nname = "x"\ndependencies = ["google-cloud-aiplatform>=1.0", "httpx"]\n[project.urls]\nHome = "https://github.com/x/y"\n',
      }),
    );
    assert.equal(res.passed, false);
    assert.deepEqual(res.failures.sort(), [
      'provider SDK: pyproject.toml depends on google-cloud-aiplatform',
      'provider SDK: requirements-dev.txt:1 depends on botocore',
      'provider SDK: requirements.txt:3 depends on anthropic',
    ]);
  });

  it('E1 hard-coded external hosts or URLs in code are refused; docs, docstrings, tests and loopback defaults are not', () => {
    const res = check(
      skillFiles({
        'discord_progress/post.py': 'URL = "https://discord.com/api/v10/channels"\nHOST = "api.openai.com"\nIP = "52.1.2.3"\nLOCAL = "http://127.0.0.1:8080"\nINTERNAL = "http://control-plane.factory.internal:8088"\nNAME = "skill.yaml"\n',
        'scripts/run.sh': 'curl https://hooks.slack.com/services/x\n',
        'docs/usage.md': 'Call https://discord.com/api from your browser.\n',
        'examples/demo.py': 'URL = "https://discord.com/api"\n',
      }),
    );
    assert.equal(res.passed, false);
    assert.deepEqual(res.failures.sort(), [
      'hosts: discord_progress/post.py:1 hard-codes discord.com',
      'hosts: discord_progress/post.py:2 hard-codes api.openai.com',
      'hosts: discord_progress/post.py:3 hard-codes 52.1.2.3',
      'hosts: scripts/run.sh:1 hard-codes hooks.slack.com',
    ]);
  });

  it('S1 committed secrets are refused by file and line, never with the value', () => {
    const value = ['sk', 'ant', 'api03', 'Zq7XwVb2Lr9TnM4kPd8Hs1Yc'].join('-');
    const generic = ['a1b2c3d4e5', 'f6g7h8i9j0', 'k1l2'].join('');
    const res = check(
      skillFiles({
        'discord_progress/keys.py': `KEY = "${value}"\n`,
        'tests/test_keys.py': `api_key = "${generic}"\n`,
        'tests/test_placeholder.py': `api_key = "your-${generic}"  # placeholder\n`,
      }),
    );
    assert.equal(res.passed, false);
    assert.deepEqual(res.failures.sort(), ['secrets: discord_progress/keys.py:1 looks like a hard-coded credential', 'secrets: tests/test_keys.py:1 looks like a hard-coded credential']);
    assert.ok(!res.raw.includes(value) && !res.raw.includes(generic), 'the value is never reported');
  });

  it('SK1 failing tests, or no tests at all, refuse the version', () => {
    const failing = check(skillFiles({ 'tests/test_render.py': TEST_PY.replace('"discord")', '"github")') }));
    assert.equal(failing.passed, false);
    assert.equal(failing.failures.length, 1);
    assert.match(failing.failures[0], /^tests: python -m unittest discover failed \(FAILED \(failures=1\)\)$/);
    const none = check(skillFiles({ 'tests/test_render.py': null, 'tests/__init__.py': null }));
    assert.deepEqual(none.failures, ['tests: no tests found (unittest discovers test*.py files in importable folders)']);
  });

  it('SK1 the entry must exist, and the code must parse', () => {
    const res = check(skillFiles({ 'discord_progress/render.py': null, 'discord_progress/broken.py': 'def (:\n' }));
    const [parse, entry] = res.failures.sort();
    assert.match(parse, /^build: discord_progress\/broken\.py:1 does not parse as Python \(.+\)$/);
    assert.equal(entry, 'build: entry discord_progress/render.py is not a file or module in the skill folder');
    assert.equal(res.failures.length, 2);
  });

  it('SK1 an unsupported language is refused with a clear reason', () => {
    const manifest = { ...MANIFEST, language: 'node', entry: 'src/index.js' } as SkillManifest;
    const res = check(skillFiles({ 'skill.yaml': SKILL_YAML.replace('language: python', 'language: node').replace('entry: discord_progress/render.py', 'entry: src/index.js') }), { manifest });
    assert.deepEqual(res.failures, ['language: node is not supported by the factory checks yet (supported: python)']);
  });

  it('the result fits a build variable: at most 1000 characters, with the overflow counted', () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`discord_progress/m${i}.py`, 'import boto3\n']));
    const res = check(skillFiles(many));
    assert.ok(res.raw.length <= 1000, `${res.raw.length} characters`);
    assert.equal(res.passed, false);
    assert.match(res.failures.at(-1)!, /^\.\.\. and \d+ more \(see the check log\)$/);
  });
});

describe('SK1 the local checker clones the pinned commit and runs the check', { concurrency: false }, () => {
  let work: string;
  let repo: string;
  let clean = '';
  let withSdk = '';

  function git(...args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
  }

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'skill-check-local-'));
    repo = join(work, 'skills');
    mkdirSync(repo);
    git('init', '--quiet');
    for (const [rel, text] of Object.entries(skillFiles())) {
      mkdirSync(dirname(join(repo, 'skills', 'discord-progress', rel)), { recursive: true });
      writeFileSync(join(repo, 'skills', 'discord-progress', rel), text);
    }
    git('add', '.');
    git('commit', '--quiet', '-m', 'clean');
    clean = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'skills', 'discord-progress', 'discord_progress', 'llm.py'), 'import anthropic\n');
    git('add', '.');
    git('commit', '--quiet', '-m', 'sdk');
    withSdk = git('rev-parse', 'HEAD');
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  const req = (commit: string) => ({ id: MANIFEST.id, version: MANIFEST.version, repo, path: 'skills/discord-progress', commit, manifest: MANIFEST });

  it('SK1 passes the clean commit and refuses the commit that imports a provider SDK (E5)', async () => {
    const checker = localSkillChecker();
    const [a, b] = await Promise.all([checker.start(req(clean)), checker.start(req(withSdk))]);
    assert.deepEqual(await checker.result(a), { passed: true, failures: [] });
    assert.deepEqual(await checker.result(b), { passed: false, failures: ['provider SDK: discord_progress/llm.py:1 imports anthropic'] });
  });

  it('SK1 a commit that cannot be fetched fails with the reason; a lost run says to re-run', async () => {
    const checker = localSkillChecker();
    const missing = 'f'.repeat(40);
    const out = await checker.result(await checker.start(req(missing)));
    assert.deepEqual(out, { passed: false, failures: [`source: could not fetch ${repo} at ${missing}`] });
    assert.equal((await checker.result('local-unknown')).passed, false);
  });
});

describe('SK1 the CodeBuild skill checker and its project', () => {
  it('starts factory-skill-checker with the pin and the registered manifest, then follows the build until it ends', async () => {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    let polls = 0;
    const exported = JSON.stringify({ passed: false, failures: ['provider SDK: a.py:1 imports boto3'] });
    const client = {
      async send(cmd: { constructor: { name: string }; input: Record<string, unknown> }) {
        sent.push({ name: cmd.constructor.name, input: cmd.input });
        if (cmd.constructor.name === 'StartBuildCommand') return { build: { id: 'factory-skill-checker:1' } };
        polls++;
        return { builds: [polls < 2 ? { buildStatus: 'IN_PROGRESS' } : { buildStatus: 'SUCCEEDED', exportedEnvironmentVariables: [{ name: 'SKILL_CHECK_RESULT', value: exported }] }] };
      },
    };
    const checker = codeBuildSkillChecker({ client: client as never, pollMs: 1 });
    const runId = await checker.start({ id: 'discord-progress', version: '1.0.0', repo: 'https://github.com/BeerCanLabs/skill-discord-progress', path: '.', commit: 'a'.repeat(40), manifest: MANIFEST });
    assert.equal(runId, 'factory-skill-checker:1');
    assert.equal(sent[0].input.projectName, 'factory-skill-checker');
    const env = Object.fromEntries((sent[0].input.environmentVariablesOverride as Array<{ name: string; value: string }>).map((e) => [e.name, e.value]));
    assert.deepEqual(env, skillCheckEnv({ id: 'discord-progress', version: '1.0.0', repo: 'https://github.com/BeerCanLabs/skill-discord-progress', path: '.', commit: 'a'.repeat(40), manifest: MANIFEST }));
    assert.deepEqual(JSON.parse(Buffer.from(env.SKILL_MANIFEST_B64, 'base64').toString('utf8')), MANIFEST);
    assert.deepEqual(await checker.result(runId), { passed: false, failures: ['provider SDK: a.py:1 imports boto3'] });
    assert.equal(polls, 2);
  });

  it('a build that ends without a result is a failure that says why; a pass is only an explicit pass', () => {
    const failed: Build = { buildStatus: 'FAILED', phases: [{ phaseType: 'INSTALL', phaseStatus: 'FAILED', contexts: [{ message: 'Unknown runtime version' }] }] };
    assert.deepEqual(skillCheckOutcome(failed), { passed: false, failures: ['checks: the check run ended FAILED in INSTALL without a result: Unknown runtime version'] });
    assert.equal(skillCheckOutcome({ buildStatus: 'SUCCEEDED' }).passed, false);
    assert.equal(skillCheckOutcome({ buildStatus: 'SUCCEEDED', exportedEnvironmentVariables: [{ name: 'SKILL_CHECK_RESULT', value: '{"passed":true,"failures":[]}' }] }).passed, true);
    assert.equal(parseSkillCheckResult('not json').passed, false);
    assert.equal(parseSkillCheckResult('{"passed":true,"failures":["x"]}').passed, false);
    assert.deepEqual(parseSkillCheckResult('SKILL_CHECK_RESULT={"passed":false,"failures":["a\\nb"]}'), { passed: false, failures: ['a b'] });
  });

  it('landing-zones/aws/codebuild.tf embeds exactly SKILL_CHECK_SCRIPT and exports the result', () => {
    const tf = readFileSync(join(REPO_ROOT, 'landing-zones', 'aws', 'codebuild.tf'), 'utf8');
    const project = tf.match(/resource "aws_codebuild_project" "factory_skill_checker" \{[\s\S]*?\n\}\n/)?.[0];
    assert.ok(project, 'the factory_skill_checker project exists');
    assert.match(project, /name\s+= "factory-skill-checker"/);
    assert.match(project, /service_role\s+= aws_iam_role\.codebuild_skill_checker\.arn/);
    assert.match(project, /privileged_mode = false/);
    assert.doesNotMatch(project, /vpc_config/, 'like the agent builder, it runs in CodeBuild\'s own network, not the factory VPC');
    const role = tf.match(/resource "aws_iam_role_policy" "codebuild_skill_checker" \{[\s\S]*?\n\}\n/)?.[0] ?? '';
    assert.doesNotMatch(role, /ecr:/, 'the skill checker cannot push images');
    const buildspec = project.match(/buildspec = <<EOF\n([\s\S]*?)\nEOF\n/)?.[1];
    assert.ok(buildspec);
    // Terraform renders "$${" as "${" and "%%{" as "%{"; nothing else in a heredoc is interpreted.
    const spec = YAML.parse(buildspec.replaceAll('$${', '${').replaceAll('%%{', '%{')) as {
      env: { 'exported-variables': string[] };
      phases: { install: { commands: string[] }; build: { commands: string[] } };
    };
    assert.deepEqual(spec.env['exported-variables'], ['SKILL_CHECK_RESULT']);
    const writer = spec.phases.install.commands.find((c) => c.startsWith("cat > /tmp/skill_check.py <<'PY'\n"));
    assert.ok(writer, 'the install phase writes the check script');
    const embedded = writer.slice(writer.indexOf('\n') + 1).replace(/\nPY\n?$/, '\n');
    assert.equal(embedded, SKILL_CHECK_SCRIPT, 'codebuild.tf must embed SKILL_CHECK_SCRIPT verbatim (regenerate it from skill-checks.ts)');
    const run = spec.phases.build.commands.join('\n');
    assert.match(run, /python3 \/tmp\/skill_check\.py --dir "skill-repo\/\$SKILL_PATH"/);
    assert.match(run, /checkout --detach "\$GIT_COMMIT"/);
    assert.match(run, /export SKILL_CHECK_RESULT/);
  });

  it('SKILL_CHECK_SCRIPT embeds unchanged in a template literal and in Terraform', () => {
    assert.doesNotMatch(SKILL_CHECK_SCRIPT, /`|\$\{|%\{/);
    assert.ok(SKILL_CHECK_SCRIPT.startsWith('"""Factory checks'));
  });

  it('the checker follows the deployment: CodeBuild where admission uses it, local on request, otherwise none', async () => {
    assert.equal((await skillCheckerFromEnv({ FACTORY_DEPLOY_PROVIDER: 'aws' }))?.name, 'codebuild');
    assert.equal((await skillCheckerFromEnv({ FACTORY_RUNTIME: 'ecs' }))?.name, 'codebuild');
    assert.equal((await skillCheckerFromEnv({ FACTORY_SKILL_CHECKER: 'local' }))?.name, 'local');
    assert.equal(await skillCheckerFromEnv({}), undefined);
    assert.equal(await skillCheckerFromEnv({ FACTORY_RUNTIME: 'ecs', FACTORY_SKILL_CHECKER: 'none' }), undefined);
  });
});
