// DESIGN_AUTHORITY.md §6.15 (Bouncer), GAP-087, A2, E4: authorization exists once, in packages/bouncer. A route asks for
// one named privilege; nothing else compares a role.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIVILEGES } from '@beercanlabs/factory-bouncer';
import { files, read } from './support.js';

const MATRIX = 'packages/control-plane/src/route-privileges.e2e.test.ts';

const nonTest = (re: RegExp) => files('packages', (p) => re.test(p) && !p.endsWith('.test.ts'));
const controlPlane = () => nonTest(/^packages\/control-plane\/src\/.*\.ts$/);
const services = () => nonTest(/^packages\/(control-plane|gatekeeper-egress|gatekeeper-ingress)\/src\/.*\.ts$/);

/** Source with comments removed, so prose cannot trip or satisfy a check. Keeps line breaks. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

/** A role check or a role comparison written by hand: what `authorize` replaced. */
const ROLE_CHECKS = [/\bhasRole\(/, /\bauthenticate\(/, /\.roles\.includes\(/, /\.roles\.some\(/];
const roleChecks = (src: string) => src.split('\n').flatMap((line, i) => (ROLE_CHECKS.some((re) => re.test(line)) ? [`${i + 1}: ${line.trim()}`] : []));

/** The text between the parenthesis opened at `open` (the index of the `(`) and its match; skips strings, regex classes and escapes. */
function balanced(src: string, open: number): string {
  let depth = 0;
  let quote = '';
  let inClass = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced parenthesis');
}

/** The arguments of every `name(` call in `src`. */
const callArgs = (src: string, name: string) => [...src.matchAll(new RegExp(`(?<!function\\s+)\\b${name}\\(`, 'g'))].map((m) => balanced(src, m.index! + m[0].length - 1));

/** The privilege-shaped string literals of an expression (`area.action`): a method name like 'GET' is not one. */
const literals = (expr: string) => [...expr.matchAll(/'([a-z]+(?:\.[a-z-]+)+)'/g)].map((m) => m[1]);

/** The privilege names a file asks for: every literal in a `requirePrivilege(` argument, and each `privilege: '...'` property. */
function asked(src: string): string[] {
  const out: string[] = [];
  for (const args of callArgs(src, 'requirePrivilege')) {
    // The third argument, after `req, res, state,`.
    const third = args.split(',').slice(3).join(',');
    out.push(...literals(third));
  }
  for (const m of src.matchAll(/\bprivilege:\s*'([^'\n]*)'/g)) out.push(m[1]);
  return out;
}

describe('Bouncer: one authorization rule', () => {
  it('the role-check patterns recognize what they exist to forbid', () => {
    assert.equal(roleChecks("if (!hasRole(principal, 'admin')) return;").length, 1);
    assert.equal(roleChecks("const p = await authenticate(req, res, state, 'viewer');").length, 1);
    assert.equal(roleChecks("if (principal.roles.includes('admin')) ok();").length, 1);
    assert.equal(roleChecks("const ok = who.roles.some((r) => r === 'operator');").length, 1);
    assert.equal(roleChecks("const p = await authenticateRun(req, res, state, id);").length, 0, 'a run token check is not a role check');
    assert.equal(roleChecks("const p = await requirePrivilege(req, res, state, 'agents.read');").length, 0);
    assert.equal(roleChecks("// webhooks authenticate with the cartridge's secret").length, 0);
  });

  it('control-plane, gatekeeper-egress and gatekeeper-ingress source never check a role themselves', () => {
    const found = services().flatMap((f) => roleChecks(code(read(f))).map((c) => `${f}:${c}`));
    assert.deepEqual(found, [], 'ask the Bouncer: call requirePrivilege (or authorize) with a named privilege from @beercanlabs/factory-bouncer');
  });

  it('the reader finds the privileges a source file asks for', () => {
    const sample = [
      "const a = await requirePrivilege(req, res, state, 'agents.read');",
      "const b = await requirePrivilege(req, res, state, req.method === 'GET' ? 'policy.read' : 'policy.set');",
      "const c = authorize({ principal, privilege: 'schedules.write' });",
      "{ name: 'wake_agent', privilege: 'agents.wake', args: { id: { type: 'string' } } },",
      "const d = await requirePrivilege(req, res, state, `agents.${verb}`);",
    ].join('\n');
    assert.deepEqual(asked(sample), ['agents.read', 'policy.read', 'policy.set', 'schedules.write', 'agents.wake']);
  });

  it('every privilege asked for is in the contract, every one in the contract is asked for, and each call names one', () => {
    const calls = controlPlane().flatMap((f) => callArgs(code(read(f)), 'requirePrivilege').map((a) => ({ f, third: a.split(',').slice(3).join(',') })));
    const unnamed = calls.filter((c) => literals(c.third).length === 0).map((c) => `${c.f}: requirePrivilege(${c.third.trim() || '…'})`);
    assert.deepEqual(unnamed, [], 'every requirePrivilege( call must pass its privilege as a string literal, so this check can read it');
    const names = controlPlane().flatMap((f) => asked(code(read(f))));
    const known = new Set<string>(PRIVILEGES);
    assert.deepEqual([...new Set(names)].filter((n) => !known.has(n)), [], 'a privilege that is not in PRIVILEGES');
    assert.deepEqual([...known].filter((n) => !names.includes(n)), [], 'a privilege in PRIVILEGES that no route or tool asks for');
  });

  it('the matrix test and the source ask for the same privileges', () => {
    const inSource = new Set(controlPlane().flatMap((f) => asked(code(read(f)))));
    const inMatrix = new Set([...read(MATRIX).matchAll(/\bprivilege:\s*'([^'\n]*)'/g)].map((m) => m[1]));
    assert.deepEqual([...inSource].filter((n) => !inMatrix.has(n)).sort(), [], `asked in source, missing from ${MATRIX}`);
    assert.deepEqual([...inMatrix].filter((n) => !inSource.has(n)).sort(), [], `in ${MATRIX}, asked nowhere in source`);
  });

  describe('every route has a matrix row', () => {
    /** The route paths a source file serves: each `path === '...'` literal and each `path.match(...)` regex (a regex literal or a named one). */
    function routes(src: string): { literals: string[]; regexes: RegExp[] } {
      const literals = [...src.matchAll(/\bpath === '(\/[^'\n]*)'/g)].map((m) => m[1]);
      const regexes = callArgs(src, 'path.match').map((arg) => {
        const named = arg.trim().match(/^[A-Za-z_]\w*$/);
        const text = named ? src.match(new RegExp(`\\bconst ${arg.trim()}\\s*=\\s*(/.*/[a-z]*)\\s*;`))?.[1] : arg.trim();
        const m = text?.match(/^\/(.*)\/([a-z]*)$/s);
        if (!m) throw new Error(`cannot read the route pattern path.match(${arg})`);
        return new RegExp(m[1], m[2]);
      });
      return { literals, regexes };
    }

    /** The paths the matrix test calls, with its `${SKILL}` placeholder filled in. */
    const matrixPaths = () => [...read(MATRIX).replaceAll('${SKILL}', 'x').matchAll(/['`](\/[^'`\s]*)['`]/g)].map((m) => m[1]);

    it('the reader finds literal routes and regex routes, including ones with groups and slashes in a class', () => {
      const sample = [
        "if (path === '/healthz' && req.method === 'GET') {}",
        "const file = path === '.' ? 'skill.yaml' : `${path}/skill.yaml`;",
        "const a = path.match(/^\\/api\\/v1\\/runs\\/([^/]+)\\/(input|result)$/);",
        "const ONE = /^\\/api\\/v1\\/skills\\/([^/]+)$/;",
        "const b = path.match(ONE);",
      ].join('\n');
      const r = routes(sample);
      assert.deepEqual(r.literals, ['/healthz'], "a file path such as path === '.' is not a route");
      assert.equal(r.regexes.length, 2);
      assert.ok(r.regexes[0].test('/api/v1/runs/x/input'));
      assert.ok(!r.regexes[0].test('/api/v1/runs/x/other'));
      assert.ok(r.regexes[1].test('/api/v1/skills/x'));
    });

    it('every path === literal and path.match regex in control-plane source is called by the matrix test', () => {
      const paths = matrixPaths();
      const missing = controlPlane().flatMap((f) => {
        const r = routes(code(read(f)));
        return [...r.literals.filter((l) => !paths.includes(l)), ...r.regexes.filter((re) => !paths.some((p) => re.test(p))).map(String)].map((x) => `${f}: ${x}`);
      });
      assert.deepEqual(missing, [], `a route with no row in ${MATRIX}: add it there, with the privilege it asks for`);
    });
  });
});
