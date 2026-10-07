/**
 * The factory's checks on a registered skill version's code (DESIGN_AUTHORITY.md §6.14 SK1, TSK-054).
 *
 * As a pull request merges only when its required checks pass, a skill version is approved only after the factory has
 * fetched it at its pinned commit, checked its code and run its tests. A `SkillChecker` runs one check and reports a
 * pass or a list of short failures; `skills.ts` starts a check when a version is registered (or an admin re-runs it)
 * and records the outcome with `recordSkillChecks`.
 *
 * The check itself is one script, `SKILL_CHECK_SCRIPT` (Python 3.11+, standard library only), run in the skill's
 * folder. It refuses:
 *   - committed secrets (the patterns of `scripts/secret-scan.sh`, K1, S1);
 *   - provider SDK imports or dependencies (boto3, botocore, anthropic, openai, xai, google cloud and model SDKs; E1, E5);
 *   - hard-coded external hosts or URLs in code (skills reach routes through `*_BASE_URL` / `FACTORY_URL`, E1); docs,
 *     docstrings and tests may hold example URLs;
 *   - a `skill.yaml` at that commit that differs from the registered manifest;
 *   - an unsupported language, and failing or missing tests (python: `python -m unittest discover`, plus `pytest` when
 *     a pytest configuration exists).
 *
 * Checkers:
 *   - `codeBuildSkillChecker` (aws/codebuild.ts): the `factory-skill-checker` CodeBuild project
 *     (landing-zones/aws/codebuild.tf), which embeds this same script; a test keeps the two identical.
 *   - `localSkillChecker`: clones and runs the script on this machine (development; needs git and python3).
 *   - `fakeSkillChecker`: for tests.
 * Selection (`skillCheckerFromEnv`, in packages/control-plane/src/skills.ts: it loads the Landlord's CodeBuild checker, which
 * this package must not import): FACTORY_SKILL_CHECKER=codebuild|local|none; by default `codebuild` where agent
 * admission uses CodeBuild (FACTORY_DEPLOY_PROVIDER=aws, or FACTORY_RUNTIME=ecs), otherwise none: versions stay
 * `pending-build` until a checker is configured.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SkillManifest } from '@beercanlabs/factory-contract';

const execFileAsync = promisify(execFile);

/** One skill version to check: the pin and the manifest it was registered with. */
export type SkillCheckRequest = { id: string; version: string; repo: string; path: string; commit: string; manifest: SkillManifest };

export type SkillCheckOutcome = { passed: boolean; failures: string[] };

export interface SkillChecker {
  /** Recorded on the version (`checkRun.checker`), so a restarted control plane resumes only its own runs. */
  readonly name: string;
  /** Starts a check and returns its run id. Throws when the run cannot be started. */
  start(req: SkillCheckRequest): Promise<string>;
  /** Resolves when the run ends. A run that ended without a result resolves as a failure that says why. */
  result(runId: string): Promise<SkillCheckOutcome>;
}

const MAX_FAILURES = 50;
const MAX_FAILURE_CHARS = 300;

/** Cleans a failure reason for the record: one line, no control characters, bounded. */
export function cleanFailure(s: string): string {
  const one = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return one.length > MAX_FAILURE_CHARS ? `${one.slice(0, MAX_FAILURE_CHARS - 1)}…` : one;
}

/**
 * Reads the script's result (`{"passed": bool, "failures": [...]}`, optionally prefixed `SKILL_CHECK_RESULT=`). Anything
 * malformed is a failure: a check passes only when it said so.
 */
export function parseSkillCheckResult(text: string | undefined): SkillCheckOutcome {
  const raw = (text ?? '').trim().replace(/^SKILL_CHECK_RESULT=/, '');
  try {
    const parsed = JSON.parse(raw) as { passed?: unknown; failures?: unknown };
    const failures = Array.isArray(parsed.failures) ? parsed.failures.filter((f): f is string => typeof f === 'string').map(cleanFailure).filter(Boolean) : [];
    if (parsed.passed === true && failures.length === 0) return { passed: true, failures: [] };
    return { passed: false, failures: (failures.length ? failures : ['checks: the check reported a failure without a reason']).slice(0, MAX_FAILURES) };
  } catch {
    return { passed: false, failures: ['checks: the check run ended without a readable result (see the check log)'] };
  }
}

/** The pinned registered manifest, as the script reads it (`--manifest-b64` / SKILL_MANIFEST_B64). */
export function manifestB64(manifest: SkillManifest): string {
  return Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
}

/** Environment for one check run on a build service (the CodeBuild project reads these names). */
export function skillCheckEnv(req: SkillCheckRequest): Record<string, string> {
  return {
    SKILL_ID: req.id,
    SKILL_VERSION: req.version,
    REPO_URL: req.repo,
    GIT_COMMIT: req.commit,
    SKILL_PATH: req.path,
    SKILL_MANIFEST_B64: manifestB64(req.manifest),
  };
}

/** For tests: every check ends with `outcome(req)` (default: pass). `requests` records what was started. */
export function fakeSkillChecker(outcome: (req: SkillCheckRequest) => SkillCheckOutcome | Promise<SkillCheckOutcome> = () => ({ passed: true, failures: [] })) {
  const runs = new Map<string, Promise<SkillCheckOutcome>>();
  const requests: Array<SkillCheckRequest & { runId: string }> = [];
  let n = 0;
  const checker: SkillChecker & { requests: typeof requests } = {
    name: 'fake',
    requests,
    async start(req) {
      const runId = `fake-${++n}`;
      requests.push({ ...req, runId });
      runs.set(runId, Promise.resolve().then(() => outcome(req)));
      return runId;
    },
    async result(runId) {
      const run = runs.get(runId);
      if (!run) return { passed: false, failures: [`checks: run ${runId} is unknown to this checker; re-run the checks`] };
      return run;
    },
  };
  return checker;
}

/**
 * Runs the check on this machine: clones the repository, checks out the pinned commit and runs `SKILL_CHECK_SCRIPT` in
 * the skill's folder. For development, not production: it runs the skill's tests in the control plane's own
 * environment. Runs live in memory, so a restart loses them (re-run the checks).
 */
export function localSkillChecker(opts: { python?: string; git?: string; timeoutMs?: number } = {}): SkillChecker {
  const runs = new Map<string, Promise<SkillCheckOutcome>>();
  const python = opts.python ?? 'python3';
  const git = opts.git ?? 'git';
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  let n = 0;

  async function check(req: SkillCheckRequest): Promise<SkillCheckOutcome> {
    const work = mkdtempSync(join(tmpdir(), 'skill-check-'));
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_TERMINAL_PROMPT: '0' };
    try {
      const repoDir = join(work, 'repo');
      try {
        await execFileAsync(git, ['clone', '--no-checkout', '--quiet', '--', req.repo, repoDir], { env, timeout });
        await execFileAsync(git, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', req.commit], { cwd: repoDir, env, timeout });
        const { stdout } = await execFileAsync(git, ['rev-parse', 'HEAD'], { cwd: repoDir, env, encoding: 'utf8' });
        if (stdout.trim() !== req.commit) throw new Error('checked out a different commit');
      } catch {
        return { passed: false, failures: [`source: could not fetch ${req.repo} at ${req.commit}`] };
      }
      const script = join(work, 'skill_check.py');
      const out = join(work, 'result.json');
      writeFileSync(script, SKILL_CHECK_SCRIPT, 'utf8');
      const args = [script, '--dir', join(repoDir, req.path), '--manifest-b64', manifestB64(req.manifest), '--venv', join(work, 'venv'), '--out', out];
      try {
        await execFileAsync(python, args, { env, timeout, maxBuffer: 16 * 1024 * 1024 });
      } catch (err) {
        return { passed: false, failures: [`checks: the check script did not run (${python}: ${cleanFailure(err instanceof Error ? err.message : String(err)).slice(0, 120)})`] };
      }
      let text: string | undefined;
      try {
        text = readFileSync(out, 'utf8');
      } catch {
        text = undefined;
      }
      return parseSkillCheckResult(text);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  return {
    name: 'local',
    async start(req) {
      const runId = `local-${process.pid}-${Date.now()}-${++n}`;
      runs.set(runId, check(req));
      return runId;
    },
    async result(runId) {
      const run = runs.get(runId);
      if (!run) return { passed: false, failures: ['checks: the check run was lost when the control plane restarted; re-run the checks'] };
      try {
        return await run;
      } finally {
        runs.delete(runId);
      }
    },
  };
}

/**
 * The check script. Run as `python3 skill_check.py --dir <skill folder> --manifest-b64 <registered manifest> --out
 * <file>`. It prints `SKILL_CHECK_RESULT=<json>` and writes the JSON (at most 1000 characters) to `--out`.
 * landing-zones/aws/codebuild.tf (`factory-skill-checker`) embeds exactly this text; skill-checks.test.ts compares them.
 * Keep it free of backticks, "$" + "{" and "%" + "{" so it embeds unchanged in this template and in Terraform.
 */
export const SKILL_CHECK_SCRIPT = String.raw`
"""Factory checks on one skill version's code (DESIGN_AUTHORITY.md 6.14 SK1).

Runs inside the skill's folder at the pinned commit. Prints one result line, SKILL_CHECK_RESULT=<json>, and writes the
same JSON to --out: {"passed": bool, "failures": [short reasons]}. Failures name a file and line, never a value.
Generated from packages/control-plane/src/skill-checks.ts (SKILL_CHECK_SCRIPT); keep landing-zones/aws/codebuild.tf
in step (a test compares them).
"""
import argparse
import ast
import base64
import json
import os
import re
import subprocess
import sys

SKIP_DIRS = {'.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', '.github'}
DOC_EXT = {'.md', '.rst', '.txt', '.adoc'}
CONFIG_EXT = {'.js', '.mjs', '.cjs', '.ts', '.sh', '.json', '.yaml', '.yml', '.cfg', '.ini', '.toml', '.env'}
METADATA_FILES = {'skill.yaml', 'pyproject.toml', 'setup.cfg', 'package.json', 'package-lock.json'}

# The same patterns as scripts/secret-scan.sh (K1, GAP-045). A skill may not opt a line out.
KNOWN = re.compile(r'github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{20,}'
                   r'|xai-[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|ntn_[A-Za-z0-9]{30,}|secret_[A-Za-z0-9]{30,}'
                   r'|-----BEGIN [A-Z ]*PRIVATE KEY-----')
GENERIC = re.compile(r'(secret|password|passwd|api_?key|token|client_secret)[A-Za-z0-9_]*["\']?\s*[:=]\s*["\']([A-Za-z0-9_/+=.-]{20,})["\']',
                     re.IGNORECASE)
PLACEHOLDER = re.compile(r'example|EXAMPLE|placeholder|your[-_]|changeme|<[a-z_]+>')

# Provider SDKs (E1, E5, S1): a skill reaches a provider only through a gatekeeper-egress route.
SDK_MODULES = ('boto3', 'botocore', 'aiobotocore', 'aioboto3', 'anthropic', 'openai', 'xai', 'xai_sdk', 'vertexai',
               'google.cloud', 'google.genai', 'google.generativeai', 'google.ai.generativelanguage')
SDK_PACKAGES = re.compile(r'^(boto3|botocore|aiobotocore|aioboto3|anthropic|openai|xai|xai-sdk|vertexai|google-genai'
                          r'|google-generativeai|google-ai-generativelanguage|google-cloud(-[a-z0-9-]+)?)$')

URL = re.compile(r'\b(?:https?|wss?|ftp)://([^/\s"\'<>:]+)', re.IGNORECASE)
HOST = re.compile(r'^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|dev|app|gg|co|cloud|xyz|uk|eu)'
                  r'(?::\d+)?(?:/.*)?$', re.IGNORECASE)
IPV4 = re.compile(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?(?:/.*)?$')

MAX_FAILURES = 20
MAX_RESULT_CHARS = 1000


def rel_files(root):
    out = []
    for base, dirs, files in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(files):
            out.append(os.path.relpath(os.path.join(base, name), root).replace(os.sep, '/'))
    return out


def read_text(root, rel):
    try:
        with open(os.path.join(root, rel), 'rb') as f:
            data = f.read()
    except OSError:
        return None
    if b'\0' in data[:8192]:
        return None
    return data.decode('utf-8', errors='replace')


def is_test(rel):
    parts = rel.split('/')
    name = parts[-1]
    return any(p in ('test', 'tests', 'testing') for p in parts[:-1]) or name.startswith('test_') or name.endswith('_test.py') or name == 'conftest.py'


def is_doc(rel):
    parts = rel.split('/')
    return os.path.splitext(rel)[1].lower() in DOC_EXT or any(p in ('docs', 'doc', 'examples') for p in parts[:-1])


def external_host(host):
    h = host.lower().rstrip('.')
    if h in ('localhost', '0.0.0.0') or h.endswith('.internal') or h.endswith('.local') or h.endswith('.localhost'):
        return False
    if h in ('example.com', 'example.org', 'example.net') or h.endswith('.example') or h.endswith('.invalid') or h.endswith('.test'):
        return False
    for zone in ('example.com', 'example.org', 'example.net'):
        if h.endswith('.' + zone):
            return False
    m = IPV4.match(h)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return not (a in (0, 10, 127) or (a == 169 and b == 254) or (a == 172 and 16 <= b <= 31) or (a == 192 and b == 168))
    return True


def hosts_in(text):
    """External hosts named in a string: a URL's host, or the whole string when it is a bare host name or IP address."""
    found = [m.group(1) for m in URL.finditer(text) if external_host(m.group(1))]
    s = text.strip()
    if not found and (HOST.match(s) or IPV4.match(s)) and external_host(s.split('/')[0].split(':')[0]):
        found.append(s.split('/')[0])
    return found


def check_secrets(root, files, failures):
    for rel in files:
        text = read_text(root, rel)
        if text is None:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            g = GENERIC.search(line)
            generic = g and re.search(r'[a-z]', g.group(2)) and re.search(r'[0-9]', g.group(2)) and not PLACEHOLDER.search(line)
            if KNOWN.search(line) or generic:
                failures.append('secrets: %s:%d looks like a hard-coded credential' % (rel, n))


def module_of(node):
    names = []
    if isinstance(node, ast.Import):
        names = [a.name for a in node.names]
    elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
        names = [node.module] + [node.module + '.' + a.name for a in node.names]
    elif isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
        f = node.func
        fname = f.attr if isinstance(f, ast.Attribute) else f.id if isinstance(f, ast.Name) else ''
        if fname in ('__import__', 'import_module'):
            names = [node.args[0].value]
    return names


def sdk_of(name):
    for m in SDK_MODULES:
        if name == m or name.startswith(m + '.'):
            return m
    return None


def docstring_nodes(tree):
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                ids.add(id(first.value))
    return ids


def check_python(root, files, failures):
    for rel in files:
        if not rel.endswith('.py'):
            continue
        text = read_text(root, rel)
        if text is None:
            continue
        try:
            tree = ast.parse(text, filename=rel)
        except SyntaxError as e:
            failures.append('build: %s:%s does not parse as Python (%s)' % (rel, e.lineno, e.msg))
            continue
        docs = docstring_nodes(tree)
        exempt = is_test(rel) or is_doc(rel)
        for node in ast.walk(tree):
            for name in module_of(node):
                sdk = sdk_of(name)
                if sdk:
                    failures.append('provider SDK: %s:%d imports %s' % (rel, node.lineno, sdk))
                    break
            if exempt or not isinstance(node, ast.Constant) or not isinstance(node.value, str) or id(node) in docs:
                continue
            for host in hosts_in(node.value)[:1]:
                failures.append('hosts: %s:%d hard-codes %s' % (rel, node.lineno, host))


def check_other_hosts(root, files, failures):
    for rel in files:
        name = rel.split('/')[-1]
        if rel.endswith('.py') or name in METADATA_FILES or is_test(rel) or is_doc(rel):
            continue
        if os.path.splitext(name)[1].lower() not in CONFIG_EXT:
            continue
        text = read_text(root, rel)
        if text is None:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            hosts = [m.group(1) for m in URL.finditer(line) if external_host(m.group(1))]
            if hosts:
                failures.append('hosts: %s:%d hard-codes %s' % (rel, n, hosts[0]))


def requirement_name(spec):
    m = re.match(r'\s*([A-Za-z0-9][A-Za-z0-9._-]*)', spec)
    return re.sub(r'[._]+', '-', m.group(1).lower()) if m else None


def check_dependencies(root, files, failures):
    for rel in files:
        name = rel.split('/')[-1]
        deps = []
        if re.match(r'^requirements.*\.(txt|in)$', name):
            for n, line in enumerate((read_text(root, rel) or '').splitlines(), 1):
                line = line.split('#', 1)[0].strip()
                if line and not line.startswith('-'):
                    deps.append((requirement_name(line), n))
        elif name == 'pyproject.toml':
            try:
                import tomllib
                with open(os.path.join(root, rel), 'rb') as f:
                    data = tomllib.load(f)
            except Exception as e:
                failures.append('build: %s is not valid TOML (%s)' % (rel, e))
                continue
            project = data.get('project', {})
            specs = list(project.get('dependencies', []))
            for group in project.get('optional-dependencies', {}).values():
                specs += list(group)
            for group in data.get('dependency-groups', {}).values():
                specs += [g for g in group if isinstance(g, str)]
            poetry = data.get('tool', {}).get('poetry', {})
            specs += list(poetry.get('dependencies', {}).keys())
            for group in poetry.get('group', {}).values():
                specs += list(group.get('dependencies', {}).keys())
            deps += [(requirement_name(s), 0) for s in specs if isinstance(s, str)]
        for dep, n in deps:
            if dep and SDK_PACKAGES.match(dep):
                where = '%s:%d' % (rel, n) if n else rel
                failures.append('provider SDK: %s depends on %s' % (where, dep))


def parse_scalar(s):
    s = s.strip()
    if not s:
        return None
    if s[0] in '"\'' and s[-1] == s[0] and len(s) > 1:
        return s[1:-1]
    if s.startswith('[') and s.endswith(']'):
        inner = s[1:-1].strip()
        return [parse_scalar(x) for x in inner.split(',')] if inner else []
    if s.startswith('{') and s.endswith('}'):
        inner = s[1:-1].strip()
        return dict((k.strip(), parse_scalar(v)) for k, v in (p.split(':', 1) for p in inner.split(','))) if inner else {}
    if s in ('true', 'True'):
        return True
    if s in ('false', 'False'):
        return False
    if s in ('null', '~'):
        return None
    return s


def strip_comment(line):
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in '"\'' and (i == 0 or line[i - 1] in ' \t:[,{'):
            quote = ch
        elif ch == '#' and (i == 0 or line[i - 1] in ' \t'):
            break
        out.append(ch)
    return ''.join(out).rstrip()


def mini_yaml(text):
    """The block-style YAML subset skill.yaml uses (maps, lists, flow lists, scalars), for when PyYAML is absent."""
    lines = []
    for raw in text.splitlines():
        line = strip_comment(raw)
        if line.strip() and line.strip() != '---':
            lines.append((len(line) - len(line.lstrip(' ')), line.strip()))
    pos = [0]

    def block(indent):
        if pos[0] >= len(lines):
            return None
        if lines[pos[0]][1].startswith('- '):
            out = []
            while pos[0] < len(lines) and lines[pos[0]][0] == indent and lines[pos[0]][1].startswith('-'):
                item = lines[pos[0]][1][1:].strip()
                if re.match(r'^[A-Za-z0-9_-]+:(\s|$)', item):
                    lines[pos[0]] = (indent + 2, item)
                    out.append(block(indent + 2))
                else:
                    pos[0] += 1
                    out.append(parse_scalar(item))
            return out
        out = {}
        while pos[0] < len(lines) and lines[pos[0]][0] == indent and not lines[pos[0]][1].startswith('- '):
            key, _, rest = lines[pos[0]][1].partition(':')
            pos[0] += 1
            if rest.strip():
                out[key.strip()] = parse_scalar(rest)
            elif pos[0] < len(lines) and lines[pos[0]][0] > indent:
                out[key.strip()] = block(lines[pos[0]][0])
            elif pos[0] < len(lines) and lines[pos[0]][0] == indent and lines[pos[0]][1].startswith('- '):
                out[key.strip()] = block(indent)
            else:
                out[key.strip()] = None
        return out

    return block(lines[0][0]) if lines else {}


def load_yaml(text):
    if os.environ.get('SKILL_CHECK_NO_PYYAML') != '1':
        try:
            import yaml
            return yaml.safe_load(text)
        except ImportError:
            pass
    return mini_yaml(text)


def normalize(value):
    """Drops empty values, so a default the registry filled in ([] for an absent list) matches its absence."""
    if isinstance(value, dict):
        out = dict((k, normalize(v)) for k, v in value.items())
        return dict((k, v) for k, v in out.items() if v not in (None, [], {}, ''))
    if isinstance(value, list):
        return [normalize(v) for v in value]
    return value


def diff_keys(a, b, prefix=''):
    keys = []
    for k in sorted(set(a) | set(b)):
        x, y = a.get(k), b.get(k)
        if isinstance(x, dict) and isinstance(y, dict):
            keys += diff_keys(x, y, prefix + k + '.')
        elif x != y:
            keys.append(prefix + k)
    return keys


def check_manifest(root, registered, failures):
    path = os.path.join(root, 'skill.yaml')
    if not os.path.isfile(path):
        failures.append('manifest: no skill.yaml in the skill folder at this commit')
        return
    try:
        found = load_yaml(read_text(root, 'skill.yaml') or '')
    except Exception as e:
        failures.append('manifest: skill.yaml does not parse (%s)' % str(e).splitlines()[0][:120])
        return
    if not isinstance(found, dict):
        failures.append('manifest: skill.yaml is not a mapping')
        return
    keys = diff_keys(normalize(found), normalize(registered))
    if keys:
        failures.append('manifest: skill.yaml at this commit does not match the registered manifest (%s)' % ', '.join(keys[:8]))


def check_entry(root, entry, failures):
    if not entry:
        return
    candidates = [entry, entry.replace('.', '/') + '.py', os.path.join(entry.replace('.', '/'), '__init__.py')]
    if not any(os.path.isfile(os.path.join(root, c)) for c in candidates):
        failures.append('build: entry %s is not a file or module in the skill folder' % entry)


def has_pytest_config(root, files):
    if 'pytest.ini' in files or any(f.split('/')[-1] == 'conftest.py' for f in files):
        return True
    for name, marker in (('pyproject.toml', '[tool.pytest.ini_options]'), ('setup.cfg', '[tool:pytest]'), ('tox.ini', '[pytest]')):
        if name in files and marker in (read_text(root, name) or ''):
            return True
    return False


def run(cmd, cwd, env=None):
    p = subprocess.run(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    sys.stdout.write(p.stdout)
    return p.returncode, p.stdout


def test_env():
    """The skill's own code runs without the build's cloud credentials or source token (S1)."""
    env = dict((k, v) for k, v in os.environ.items()
               if not k.startswith(('AWS_', 'CODEBUILD_', 'ECS_', 'GIT_TOKEN')) and k not in ('SKILL_MANIFEST_B64',))
    env.update(PYTHONDONTWRITEBYTECODE='1', NO_COLOR='1', PYTHON_COLORS='0', PIP_DISABLE_PIP_VERSION_CHECK='1')
    return env


def run_python_tests(root, files, venv, failures):
    if sys.version_info < (3, 11):
        failures.append('tests: Python 3.11 or later is required (the check ran %d.%d)' % sys.version_info[:2])
        return
    reqs = [f for f in ('requirements.txt', 'requirements-dev.txt', 'requirements-test.txt') if f in files]
    pytest = has_pytest_config(root, files)
    python = sys.executable
    env = test_env()
    if reqs or pytest:
        import venv as venvlib
        venvlib.create(venv, with_pip=True, clear=True)
        python = os.path.join(venv, 'bin', 'python')
        for req in reqs:
            if run([python, '-m', 'pip', 'install', '-q', '-r', req], root, env)[0] != 0:
                failures.append('build: pip could not install %s' % req)
                return
        if pytest and run([python, '-m', 'pip', 'install', '-q', 'pytest'], root, env)[0] != 0:
            failures.append('build: pip could not install pytest')
            return
    code, out = run([python, '-m', 'unittest', 'discover', '-v'], root, env)
    ran = re.search(r'^Ran (\d+) tests?', out, re.MULTILINE)
    if ran is None or int(ran.group(1)) == 0:
        if not pytest:
            failures.append('tests: no tests found (unittest discovers test*.py files in importable folders)')
    elif code != 0:
        failures.append('tests: python -m unittest discover failed (%s)' % summary(out))
    if pytest:
        code, out = run([python, '-m', 'pytest', '-q'], root, env)
        if code == 5:
            failures.append('tests: pytest is configured but collected no tests')
        elif code != 0:
            failures.append('tests: pytest failed (%s)' % summary(out))


def summary(out):
    for line in reversed(out.strip().splitlines()):
        line = line.strip()
        if line.startswith('FAILED') or ' failed' in line or line.startswith('ERROR'):
            return line[:120]
    return 'see the check log'


def result(failures):
    shown = failures[:MAX_FAILURES]
    while True:
        more = len(failures) - len(shown)
        items = shown + (['... and %d more (see the check log)' % more] if more else [])
        out = json.dumps({'passed': not failures, 'failures': items}, separators=(',', ':'))
        if len(out) <= MAX_RESULT_CHARS or not shown:
            return out
        shown = shown[:-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default='.')
    ap.add_argument('--manifest-b64', default=os.environ.get('SKILL_MANIFEST_B64', ''))
    ap.add_argument('--venv', default='/tmp/skill-check-venv')
    ap.add_argument('--out', default='')
    args = ap.parse_args()
    root = os.path.abspath(args.dir)
    failures = []
    try:
        registered = json.loads(base64.b64decode(args.manifest_b64).decode('utf-8')) if args.manifest_b64 else None
    except Exception:
        registered = None
    if not isinstance(registered, dict):
        failures.append('manifest: the registered manifest was not passed to the check')
        registered = {}
    if not os.path.isdir(root):
        failures.append('source: the skill folder does not exist at this commit')
    else:
        files = rel_files(root)
        language = str(registered.get('language', ''))
        check_manifest(root, registered, failures)
        check_secrets(root, files, failures)
        check_dependencies(root, files, failures)
        check_other_hosts(root, files, failures)
        if language == 'python':
            check_entry(root, str(registered.get('entry', '')), failures)
            check_python(root, files, failures)
            if not failures:
                run_python_tests(root, files, args.venv, failures)
        else:
            failures.append('language: %s is not supported by the factory checks yet (supported: python)' % (language or '(none)'))
    out = result(failures)
    for f in failures:
        print('SKILL CHECK FAILED: ' + f)
    print('SKILL_CHECK_RESULT=' + out)
    if args.out:
        with open(args.out, 'w') as f:
            f.write(out)


if __name__ == '__main__':
    main()
`.replace(/^\n/, '');
