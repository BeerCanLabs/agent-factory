// DESIGN_AUTHORITY.md §6.15 (Bouncer), GAP-087, A2, E4: authorization exists once, in packages/bouncer. A route asks for
// one named privilege; nothing else compares a role.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { PRIVILEGES } from '@beercanlabs/factory-bouncer';
import {
  CONTROL_PLANE_ROUTES,
  ROUTE_EXCEPTIONS,
  validateRouteRegistry,
  getRoutePrivileges,
  pathToRegex,
  ControlPlaneRoute,
  HttpMethod,
} from '@beercanlabs/factory-control-plane/routes';
import { files, read } from './support.js';

const MATRIX = 'packages/control-plane/src/route-privileges.e2e.test.ts';

const nonTest = (re: RegExp) => files('packages', (p) => re.test(p) && !p.endsWith('.test.ts'));
const controlPlane = () => nonTest(/^packages\/control-plane\/src\/.*\.ts$/).filter((p) => !p.endsWith('/route-registry.ts'));
const services = () => nonTest(/^packages\/(control-plane|gatekeeper)\/src\/.*\.ts$/);

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

  describe('S14: route-exception registry and privilege table completeness', () => {
    const ALL_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

    function findMatchingParen(pattern: string, open: number): number {
      let depth = 0;
      let inClass = false;
      for (let i = open; i < pattern.length; i++) {
        if (pattern[i] === '\\' && i + 1 < pattern.length) {
          i++;
          continue;
        }
        if (inClass) {
          if (pattern[i] === ']') inClass = false;
          continue;
        }
        if (pattern[i] === '[') {
          inClass = true;
          continue;
        }
        if (pattern[i] === '(') depth++;
        else if (pattern[i] === ')' && --depth === 0) return i;
      }
      return -1;
    }

    function dedupe<T>(items: readonly T[]): T[] {
      return [...new Set(items)];
    }

    function expandAlternations(pattern: string): string[] {
      // 1. Expand optional groups: both non-capturing `(?:...)?` and capturing `(...)?` outside character classes.
      let inClass = false;
      for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === '\\' && i + 1 < pattern.length) {
          i++;
          continue;
        }
        if (inClass) {
          if (pattern[i] === ']') inClass = false;
          continue;
        }
        if (pattern[i] === '[') {
          inClass = true;
          continue;
        }
        if (pattern[i] === '(') {
          const close = findMatchingParen(pattern, i);
          if (close !== -1 && pattern[close + 1] === '?') {
            const rawInner = pattern.slice(i + 1, close);
            if (!rawInner.startsWith('?=') && !rawInner.startsWith('?!') && !rawInner.startsWith('?<')) {
              const inner = rawInner.startsWith('?:') ? rawInner.slice(2) : rawInner;
              const prefix = pattern.slice(0, i);
              const suffix = pattern.slice(close + 2);
              return dedupe([
                ...expandAlternations(prefix + suffix),
                ...expandAlternations(prefix + inner + suffix),
              ]);
            }
          }
        }
      }

      // 2. Expand top-level pipe alternations `(a|b|...)` outside character classes.
      inClass = false;
      for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === '\\' && i + 1 < pattern.length) {
          i++;
          continue;
        }
        if (inClass) {
          if (pattern[i] === ']') inClass = false;
          continue;
        }
        if (pattern[i] === '[') {
          inClass = true;
          continue;
        }
        if (pattern[i] === '(') {
          const close = findMatchingParen(pattern, i);
          if (close !== -1) {
            const rawInner = pattern.slice(i + 1, close);
            if (!rawInner.startsWith('?=') && !rawInner.startsWith('?!') && !rawInner.startsWith('?<')) {
              const start = rawInner.startsWith('?:') ? 2 : 0;
              let depth = 0;
              let subInClass = false;
              let hasPipe = false;
              const branches: string[] = [];
              let cur = '';
              for (let j = start; j < rawInner.length; j++) {
                const ch = rawInner[j];
                if (ch === '\\' && j + 1 < rawInner.length) {
                  cur += ch + rawInner[j + 1];
                  j++;
                  continue;
                }
                if (subInClass) {
                  if (ch === ']') subInClass = false;
                  cur += ch;
                  continue;
                }
                if (ch === '[') {
                  subInClass = true;
                  cur += ch;
                  continue;
                }
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                else if (ch === '|' && depth === 0) {
                  hasPipe = true;
                  branches.push(cur);
                  cur = '';
                  continue;
                }
                cur += ch;
              }
              branches.push(cur);
              if (hasPipe) {
                const prefix = pattern.slice(0, i);
                const suffix = pattern.slice(close + 1);
                const out: string[] = [];
                for (const b of branches) {
                  out.push(...expandAlternations(prefix + b + suffix));
                }
                return dedupe(out);
              }
            }
          }
        }
      }

      return [pattern];
    }

    function renderRegexBranch(branch: string, mode: 'sample' | 'canonical'): string {
      let s = branch;
      if (s.startsWith('^')) s = s.slice(1);
      if (s.endsWith('$')) s = s.slice(0, -1);
      let out = '';
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          out += s[i + 1];
          i++;
          continue;
        }
        if (s[i] === '(') {
          const close = findMatchingParen(s, i);
          if (close !== -1) {
            const inner = s.slice(i + 1, close);
            if (inner.startsWith('?:') && !/[[\]+*?.]|\\[dwsDWS]/.test(inner.slice(2))) {
              out += renderRegexBranch(inner.slice(2), mode);
            } else if (mode === 'canonical') {
              out += ':param';
            } else {
              out += inner.startsWith('\\d') || inner.startsWith('[0-9') ? '1' : 'param1';
            }
            i = close;
            continue;
          }
        }
        out += s[i];
      }
      return out;
    }

    function canonicalizeRegistryPattern(pattern: string): string {
      return pattern.replace(/:[a-zA-Z0-9_]+/g, ':param');
    }

    function samplePath(pattern: string): string {
      return pattern.replace(/:version\b/g, '1').replace(/:[a-zA-Z0-9_]+/g, 'param1');
    }

    type DispatchedRoute = {
      method: HttpMethod;
      pattern: string;
      canonical: string;
      sample: string;
      isRegex: boolean;
      file?: string;
      requiredPrivileges: string[];
      authorizedPrivileges: string[];
      enforcedPrivileges: string[];
    };

    type SourceUnit = { file: string; src: string };

    type RegexInfo = { pattern: string; flags: string };

    type PathCandidate =
      | { kind: 'literal'; pattern: string; canonical: string; sample: string }
      | { kind: 'regex'; pattern: string; origPattern: string; flags: string; canonical: string; sample: string };

    type LocalFnInfo = {
      key: string;
      params: string[];
      body: ts.ConciseBody;
      declScope: LexScope;
    };

    class LexScope {
      readonly strings = new Map<string, string>();
      readonly stringArrays = new Map<string, string[]>();
      readonly regexes = new Map<string, RegexInfo>();
      readonly matches = new Map<string, RegexInfo[]>();
      readonly exprs = new Map<string, ts.Expression>();
      readonly localFns = new Map<string, LocalFnInfo>();
      readonly pathVars = new Set<string>();
      readonly urlVars = new Set<string>();

      constructor(readonly parent?: LexScope) {}

      child(): LexScope {
        return new LexScope(this);
      }

      getString(name: string): string | undefined {
        return this.strings.get(name) ?? this.parent?.getString(name);
      }

      getStringArray(name: string): string[] | undefined {
        return this.stringArrays.get(name) ?? this.parent?.getStringArray(name);
      }

      getRegex(name: string): RegexInfo | undefined {
        return this.regexes.get(name) ?? this.parent?.getRegex(name);
      }

      getMatch(name: string): RegexInfo[] | undefined {
        return this.matches.get(name) ?? this.parent?.getMatch(name);
      }

      getExpr(name: string): ts.Expression | undefined {
        return this.exprs.get(name) ?? this.parent?.getExpr(name);
      }

      getLocalFn(name: string): LocalFnInfo | undefined {
        return this.localFns.get(name) ?? this.parent?.getLocalFn(name);
      }

      isPathVar(name: string): boolean {
        return this.pathVars.has(name) || Boolean(this.parent?.isPathVar(name));
      }

      isUrlVar(name: string): boolean {
        return this.urlVars.has(name) || Boolean(this.parent?.isUrlVar(name));
      }
    }

    function unwrapExpr(node: ts.Expression): ts.Expression {
      let cur = node;
      while (
        ts.isParenthesizedExpression(cur) ||
        ts.isAsExpression(cur) ||
        ts.isNonNullExpression(cur) ||
        ts.isSatisfiesExpression(cur)
      ) {
        cur = cur.expression;
      }
      return cur;
    }

    function extractStringConst(node: ts.Expression, scope: LexScope): string | undefined {
      const e = unwrapExpr(node);
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
        return e.text;
      }
      if (ts.isIdentifier(e)) {
        return scope.getString(e.text);
      }
      return undefined;
    }

    function extractStringArrayConst(node: ts.Expression, scope: LexScope): string[] | undefined {
      const e = unwrapExpr(node);
      if (ts.isArrayLiteralExpression(e)) {
        const items: string[] = [];
        for (const el of e.elements) {
          if (!ts.isExpression(el)) return undefined;
          const s = extractStringConst(el as ts.Expression, scope);
          if (s === undefined) return undefined;
          items.push(s);
        }
        return items;
      }
      if (ts.isIdentifier(e)) {
        return scope.getStringArray(e.text);
      }
      return undefined;
    }

    function extractRegexConst(node: ts.Expression, scope: LexScope): RegexInfo | undefined {
      const e = unwrapExpr(node);
      if (ts.isRegularExpressionLiteral(e)) {
        const m = e.text.match(/^\/(.*)\/([a-z]*)$/s);
        if (m) return { pattern: m[1], flags: m[2] };
      }
      if (ts.isIdentifier(e)) {
        return scope.getRegex(e.text);
      }
      return undefined;
    }

    function isRequestPathExpr(node: ts.Expression, scope: LexScope): boolean {
      const e = unwrapExpr(node);
      if (ts.isIdentifier(e)) {
        return scope.isPathVar(e.text);
      }
      if (ts.isPropertyAccessExpression(e) && e.name.text === 'pathname' && ts.isIdentifier(e.expression)) {
        return scope.isUrlVar(e.expression.text);
      }
      return false;
    }

    function isReqMethodExpr(node: ts.Expression): boolean {
      const e = unwrapExpr(node);
      if (
        ts.isPropertyAccessExpression(e) &&
        e.name.text === 'method' &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === 'req'
      ) {
        return true;
      }
      if (
        ts.isBinaryExpression(e) &&
        (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          e.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
        isReqMethodExpr(e.left) &&
        ts.isStringLiteral(unwrapExpr(e.right)) &&
        (unwrapExpr(e.right) as ts.StringLiteral).text === ''
      ) {
        return true;
      }
      return false;
    }

    function extractMatchRegexes(node: ts.Expression, scope: LexScope): RegexInfo[] | undefined {
      const e = unwrapExpr(node);
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === 'match' &&
        isRequestPathExpr(e.expression.expression, scope) &&
        e.arguments.length > 0
      ) {
        const reg = extractRegexConst(e.arguments[0], scope);
        if (reg) return [reg];
      }
      if (
        ts.isBinaryExpression(e) &&
        (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
      ) {
        const l = extractMatchRegexes(e.left, scope);
        const r = extractMatchRegexes(e.right, scope);
        if (l && r) return [...l, ...r];
      }
      return undefined;
    }

    function isPathSplitInit(node: ts.Expression, scope: LexScope): boolean {
      const e = unwrapExpr(node);
      if (
        ts.isElementAccessExpression(e) &&
        ts.isNumericLiteral(e.argumentExpression) &&
        e.argumentExpression.text === '0'
      ) {
        return isPathSplitCall(e.expression, scope);
      }
      return false;
    }

    function isPathSplitCall(node: ts.Expression, scope: LexScope): boolean {
      const e = unwrapExpr(node);
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === 'split' &&
        e.arguments.length > 0
      ) {
        const sep = extractStringConst(e.arguments[0], scope);
        if (sep !== '?') return false;
        const target = unwrapExpr(e.expression.expression);
        if (isRequestPathExpr(target, scope)) return true;
        // `(req.url ?? '/').split('?')`
        if (ts.isBinaryExpression(target)) {
          const left = unwrapExpr(target.left);
          if (
            ts.isPropertyAccessExpression(left) &&
            left.name.text === 'url' &&
            ts.isIdentifier(left.expression) &&
            left.expression.text === 'req'
          ) {
            return true;
          }
        }
      }
      return false;
    }

    function exprMentionsReqUrlOrPath(node: ts.Expression, scope: LexScope): boolean {
      let found = false;
      function walk(n: ts.Node) {
        if (found) return;
        if (ts.isExpression(n) && isRequestPathExpr(n, scope)) {
          found = true;
          return;
        }
        if (
          ts.isPropertyAccessExpression(n) &&
          n.name.text === 'url' &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === 'req'
        ) {
          found = true;
          return;
        }
        ts.forEachChild(n, walk);
      }
      walk(node);
      return found;
    }

    function isNewReqUrlInit(node: ts.Expression, scope: LexScope): boolean {
      const e = unwrapExpr(node);
      return (
        ts.isNewExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === 'URL' &&
        Boolean(e.arguments?.length && exprMentionsReqUrlOrPath(e.arguments[0], scope))
      );
    }

    function registerVarDeclaration(decl: ts.VariableDeclaration, isConst: boolean, scope: LexScope): void {
      if (ts.isArrayBindingPattern(decl.name) && decl.initializer && isPathSplitCall(decl.initializer, scope)) {
        const first = decl.name.elements[0];
        if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
          scope.pathVars.add(first.name.text);
        }
        return;
      }
      if (!isConst || !ts.isIdentifier(decl.name) || !decl.initializer) return;
      const name = decl.name.text;
      const init = decl.initializer;

      if (isPathSplitInit(init, scope)) {
        scope.pathVars.add(name);
        return;
      }
      if (isNewReqUrlInit(init, scope)) {
        scope.urlVars.add(name);
        return;
      }
      const str = extractStringConst(init, scope);
      if (str !== undefined) {
        scope.strings.set(name, str);
        return;
      }
      const arr = extractStringArrayConst(init, scope);
      if (arr !== undefined) {
        scope.stringArrays.set(name, arr);
        return;
      }
      const reg = extractRegexConst(init, scope);
      if (reg !== undefined) {
        scope.regexes.set(name, reg);
        return;
      }
      const matchRegs = extractMatchRegexes(init, scope);
      if (matchRegs !== undefined) {
        scope.matches.set(name, matchRegs);
        return;
      }
      const unwrappedInit = unwrapExpr(init);
      if (ts.isArrowFunction(unwrappedInit) || ts.isFunctionExpression(unwrappedInit)) {
        const params = unwrappedInit.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : ''));
        scope.localFns.set(name, {
          key: `local#${name}@${unwrappedInit.pos}`,
          params,
          body: unwrappedInit.body,
          declScope: scope,
        });
        return;
      }
      scope.exprs.set(name, init);
    }

    function resolveRelativeImport(fromFile: string, spec: string): string {
      const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '.';
      const tsSpec = spec.replace(/\.js$/, '.ts');
      const parts = `${dir}/${tsSpec}`.split('/');
      const norm: string[] = [];
      for (const p of parts) {
        if (p === '.' || p === '') continue;
        if (p === '..') norm.pop();
        else norm.push(p);
      }
      return norm.join('/');
    }

    type HelperRecord = {
      key: string;
      file: string;
      params: string[];
      body: ts.ConciseBody;
      fileScope: LexScope;
      hasMethodDispatch: boolean;
    };

    function nodeMentionsReqMethod(node: ts.Node): boolean {
      let found = false;
      function walk(n: ts.Node) {
        if (found) return;
        if (ts.isExpression(n) && isReqMethodExpr(n)) {
          found = true;
          return;
        }
        ts.forEachChild(n, walk);
      }
      walk(node);
      return found;
    }

    const parsedSourceCache = new Map<string, { src: string; sf: ts.SourceFile; fileScope: LexScope }>();
    const unitRouteCache = new Map<string, { sig: string; routes: readonly DispatchedRoute[] }>();

    function parseSourceUnit(u: SourceUnit): { file: string; src: string; sf: ts.SourceFile; fileScope: LexScope } {
      const hit = parsedSourceCache.get(u.file);
      if (hit && hit.src === u.src) {
        return { file: u.file, ...hit };
      }
      const sf = ts.createSourceFile(u.file, u.src, ts.ScriptTarget.Latest, true);
      const fileScope = new LexScope();
      for (const stmt of sf.statements) {
        if (ts.isVariableStatement(stmt)) {
          const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
          for (const decl of stmt.declarationList.declarations) {
            registerVarDeclaration(decl, isConst, fileScope);
          }
        }
      }
      if (u.file !== 'inline.ts') {
        parsedSourceCache.set(u.file, { src: u.src, sf, fileScope });
      }
      return { ...u, sf, fileScope };
    }

    function analyzeControlPlane(units: readonly SourceUnit[]): DispatchedRoute[] {
      const parsedUnits = units.map(parseSourceUnit);

      const unitByFile = new Map(parsedUnits.map((p) => [p.file, p]));
      const localHelpers = new Map<string, Map<string, HelperRecord>>();
      const exportedHelpers = new Map<string, Map<string, HelperRecord>>();
      const importedHelpers = new Map<string, Map<string, { targetFile: string; exportedName: string }>>();

      for (const p of parsedUnits) {
        const loc = new Map<string, HelperRecord>();
        const exp = new Map<string, HelperRecord>();
        const imp = new Map<string, { targetFile: string; exportedName: string }>();

        for (const stmt of p.sf.statements) {
          if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const spec = stmt.moduleSpecifier.text;
            if (spec.startsWith('.')) {
              const targetFile = resolveRelativeImport(p.file, spec);
              const named = stmt.importClause?.namedBindings;
              if (named && ts.isNamedImports(named)) {
                for (const el of named.elements) {
                  if (el.isTypeOnly) continue;
                  const exportedName = (el.propertyName ?? el.name).text;
                  imp.set(el.name.text, { targetFile, exportedName });
                }
              }
            }
          } else if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
            const name = stmt.name.text;
            const params = stmt.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : ''));
            const rec: HelperRecord = {
              key: `${p.file}#${name}`,
              file: p.file,
              params,
              body: stmt.body,
              fileScope: p.fileScope,
              hasMethodDispatch: nodeMentionsReqMethod(stmt.body),
            };
            loc.set(name, rec);
            if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
              exp.set(name, rec);
            }
          } else if (ts.isVariableStatement(stmt)) {
            const isExported = Boolean(stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
            for (const decl of stmt.declarationList.declarations) {
              if (
                ts.isIdentifier(decl.name) &&
                decl.initializer &&
                (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
              ) {
                const name = decl.name.text;
                const fn = decl.initializer;
                const params = fn.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : ''));
                const rec: HelperRecord = {
                  key: `${p.file}#${name}`,
                  file: p.file,
                  params,
                  body: fn.body,
                  fileScope: p.fileScope,
                  hasMethodDispatch: nodeMentionsReqMethod(fn.body),
                };
                loc.set(name, rec);
                if (isExported) exp.set(name, rec);
              }
            }
          }
        }

        localHelpers.set(p.file, loc);
        exportedHelpers.set(p.file, exp);
        importedHelpers.set(p.file, imp);
      }

      function resolveHelper(currentFile: string, identName: string): HelperRecord | undefined {
        const loc = localHelpers.get(currentFile)?.get(identName);
        if (loc) return loc;
        const imp = importedHelpers.get(currentFile)?.get(identName);
        if (imp && unitByFile.has(imp.targetFile)) {
          return exportedHelpers.get(imp.targetFile)?.get(imp.exportedName);
        }
        return undefined;
      }

      type EvalResult = {
        value: boolean | 'unknown';
        usedPath: boolean;
        usedMethod: boolean;
      };

      function execMatchInfo(regs: readonly RegexInfo[], candidate: PathCandidate): RegExpExecArray | null {
        for (const r of regs) {
          // A parameterized route regex (`([^/]+)`) has its own regex PathCandidate(s); do not let unrelated
          // literal PathCandidates (e.g. '/api/v1/models/scan') masquerade as literal routes on wildcard regexes.
          if (candidate.kind === 'literal' && r.pattern.includes('(')) continue;
          const m = new RegExp(r.pattern, r.flags).exec(candidate.sample);
          if (m) return m;
        }
        return null;
      }

      function candidateMatchesLiteral(candidate: PathCandidate, lit: string): boolean {
        if (candidate.kind === 'literal') return candidate.pattern === lit;
        return !candidate.pattern.includes('(') && candidate.sample === lit;
      }

      function evalScalar(
        node: ts.Expression,
        scope: LexScope,
        method: HttpMethod,
        candidate: PathCandidate,
      ): { known: true; value: string | undefined; usedPath: boolean; usedMethod: boolean } | { known: false } {
        const e = unwrapExpr(node);
        if (isReqMethodExpr(e)) {
          return { known: true, value: method, usedPath: false, usedMethod: true };
        }
        if (isRequestPathExpr(e, scope)) {
          if (candidate.kind === 'literal' || !candidate.pattern.includes('(')) {
            return { known: true, value: candidate.sample, usedPath: true, usedMethod: false };
          }
          // A parameterized regex candidate does not equal any static string literal, so expose its sample
          // with a marker checked by equality comparisons.
          return { known: true, value: candidate.sample, usedPath: true, usedMethod: false };
        }
        const str = extractStringConst(e, scope);
        if (str !== undefined) {
          return { known: true, value: str, usedPath: false, usedMethod: false };
        }
        if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isNumericLiteral(e.argumentExpression)) {
          const matchRegs = scope.getMatch(e.expression.text);
          if (matchRegs) {
            const idx = Number(e.argumentExpression.text);
            const m = execMatchInfo(matchRegs, candidate);
            return { known: true, value: m ? m[idx] : undefined, usedPath: true, usedMethod: false };
          }
        }
        return { known: false };
      }

      function evalCond(
        node: ts.Expression,
        scope: LexScope,
        method: HttpMethod,
        candidate: PathCandidate,
        seenExprIds = new Set<string>(),
      ): EvalResult {
        const e = unwrapExpr(node);

        if (e.kind === ts.SyntaxKind.TrueKeyword) return { value: true, usedPath: false, usedMethod: false };
        if (e.kind === ts.SyntaxKind.FalseKeyword) return { value: false, usedPath: false, usedMethod: false };

        if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
          const inner = evalCond(e.operand, scope, method, candidate, seenExprIds);
          return {
            value: inner.value === 'unknown' ? 'unknown' : !inner.value,
            usedPath: inner.usedPath,
            usedMethod: inner.usedMethod,
          };
        }

        if (ts.isBinaryExpression(e)) {
          const op = e.operatorToken.kind;

          if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = evalCond(e.left, scope, method, candidate, seenExprIds);
            if (left.value === false) {
              return { value: false, usedPath: left.usedPath, usedMethod: left.usedMethod };
            }
            const right = evalCond(e.right, scope, method, candidate, seenExprIds);
            if (right.value === false) {
              return {
                value: false,
                usedPath: left.usedPath || right.usedPath,
                usedMethod: left.usedMethod || right.usedMethod,
              };
            }
            if (left.value === true && right.value === true) {
              return {
                value: true,
                usedPath: left.usedPath || right.usedPath,
                usedMethod: left.usedMethod || right.usedMethod,
              };
            }
            return {
              value: 'unknown',
              usedPath: left.usedPath || right.usedPath,
              usedMethod: left.usedMethod || right.usedMethod,
            };
          }

          if (op === ts.SyntaxKind.BarBarToken) {
            const left = evalCond(e.left, scope, method, candidate, seenExprIds);
            if (left.value === true) {
              return { value: true, usedPath: left.usedPath, usedMethod: left.usedMethod };
            }
            const right = evalCond(e.right, scope, method, candidate, seenExprIds);
            if (right.value === true) {
              return {
                value: true,
                usedPath: left.usedPath || right.usedPath,
                usedMethod: left.usedMethod || right.usedMethod,
              };
            }
            if (left.value === false && right.value === false) {
              return {
                value: false,
                usedPath: left.usedPath || right.usedPath,
                usedMethod: left.usedMethod || right.usedMethod,
              };
            }
            return {
              value: 'unknown',
              usedPath: left.usedPath || right.usedPath,
              usedMethod: left.usedMethod || right.usedMethod,
            };
          }

          if (
            op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
            op === ts.SyntaxKind.EqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
            op === ts.SyntaxKind.ExclamationEqualsToken
          ) {
            const isNeg = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
            // Direct path === lit / lit === path check using candidateMatchesLiteral
            if (isRequestPathExpr(e.left, scope)) {
              const lit = extractStringConst(e.right, scope);
              if (lit !== undefined) {
                const eq = candidateMatchesLiteral(candidate, lit);
                return { value: isNeg ? !eq : eq, usedPath: true, usedMethod: false };
              }
            }
            if (isRequestPathExpr(e.right, scope)) {
              const lit = extractStringConst(e.left, scope);
              if (lit !== undefined) {
                const eq = candidateMatchesLiteral(candidate, lit);
                return { value: isNeg ? !eq : eq, usedPath: true, usedMethod: false };
              }
            }
            const ls = evalScalar(e.left, scope, method, candidate);
            const rs = evalScalar(e.right, scope, method, candidate);
            if (ls.known && rs.known) {
              const eq = ls.value === rs.value;
              return {
                value: isNeg ? !eq : eq,
                usedPath: ls.usedPath || rs.usedPath,
                usedMethod: ls.usedMethod || rs.usedMethod,
              };
            }
          }
        }

        if (ts.isIdentifier(e)) {
          const matchRegs = scope.getMatch(e.text);
          if (matchRegs) {
            const m = execMatchInfo(matchRegs, candidate);
            return { value: m !== null, usedPath: true, usedMethod: false };
          }
          if (!seenExprIds.has(e.text)) {
            const boundExpr = scope.getExpr(e.text);
            if (boundExpr) {
              const nextSeen = new Set(seenExprIds);
              nextSeen.add(e.text);
              return evalCond(boundExpr, scope, method, candidate, nextSeen);
            }
          }
        }

        if (ts.isElementAccessExpression(e) && ts.isIdentifier(e.expression) && ts.isNumericLiteral(e.argumentExpression)) {
          const matchRegs = scope.getMatch(e.expression.text);
          if (matchRegs) {
            const idx = Number(e.argumentExpression.text);
            const m = execMatchInfo(matchRegs, candidate);
            return { value: Boolean(m && m[idx]), usedPath: true, usedMethod: false };
          }
        }

        if (ts.isCallExpression(e)) {
          if (ts.isIdentifier(e.expression) && e.expression.text === 'Boolean' && e.arguments.length === 1) {
            return evalCond(e.arguments[0], scope, method, candidate, seenExprIds);
          }
          if (ts.isPropertyAccessExpression(e.expression)) {
            const prop = e.expression.name.text;
            const recv = e.expression.expression;

            // REGEX.test(path | pathname)
            if (prop === 'test' && e.arguments.length >= 1 && isRequestPathExpr(e.arguments[0], scope)) {
              const reg = extractRegexConst(recv, scope);
              if (reg) {
                const isExactRouteRegex = reg.pattern.startsWith('^') && reg.pattern.endsWith('$');
                if (isExactRouteRegex && candidate.kind === 'literal' && reg.pattern.includes('(')) {
                  return { value: false, usedPath: true, usedMethod: false };
                }
                const matched = new RegExp(reg.pattern, reg.flags).test(candidate.sample);
                return { value: matched, usedPath: isExactRouteRegex, usedMethod: false };
              }
            }

            // path.startsWith('/prefix') — prefix filter, not a concrete endpoint match
            if (prop === 'startsWith' && e.arguments.length >= 1 && isRequestPathExpr(recv, scope)) {
              const prefix = extractStringConst(e.arguments[0], scope);
              if (prefix !== undefined) {
                return { value: candidate.sample.startsWith(prefix), usedPath: false, usedMethod: false };
              }
            }

            // ['POST', 'PUT', ...].includes(req.method) or [PROMPTS, DECISION].includes(path)
            if (prop === 'includes' && e.arguments.length >= 1) {
              const arr = extractStringArrayConst(recv, scope);
              if (arr) {
                if (isReqMethodExpr(e.arguments[0])) {
                  return { value: arr.includes(method), usedPath: false, usedMethod: true };
                }
                if (isRequestPathExpr(e.arguments[0], scope)) {
                  const hit = arr.some((item) => candidateMatchesLiteral(candidate, item));
                  return { value: hit, usedPath: true, usedMethod: false };
                }
              }
            }
          }
        }

        return { value: 'unknown', usedPath: false, usedMethod: false };
      }

      type PrivAccumulator = {
        required: Set<string>;
        authorized: Set<string>;
      };

      function extractPrivStringsFromExpr(
        expr: ts.Expression,
        scope: LexScope,
        method: HttpMethod,
        candidate: PathCandidate,
      ): string[] {
        const e = unwrapExpr(expr);
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
          return /^[a-z]+(?:\.[a-z-]+)+$/.test(e.text) ? [e.text] : [];
        }
        if (ts.isIdentifier(e)) {
          const s = scope.getString(e.text);
          if (s && /^[a-z]+(?:\.[a-z-]+)+$/.test(s)) return [s];
          return [];
        }
        if (ts.isConditionalExpression(e)) {
          const c = evalCond(e.condition, scope, method, candidate);
          if (c.value === true) return extractPrivStringsFromExpr(e.whenTrue, scope, method, candidate);
          if (c.value === false) return extractPrivStringsFromExpr(e.whenFalse, scope, method, candidate);
          return dedupe([
            ...extractPrivStringsFromExpr(e.whenTrue, scope, method, candidate),
            ...extractPrivStringsFromExpr(e.whenFalse, scope, method, candidate),
          ]);
        }
        return [];
      }

      function collectPrivilegesFromNode(
        node: ts.Node,
        currentFile: string,
        scope: LexScope,
        method: HttpMethod,
        candidate: PathCandidate,
        visitedHelpers: Set<string>,
        acc: PrivAccumulator,
      ): void {
        function walk(n: ts.Node, curScope: LexScope): void {
          // Do not descend into nested function declarations/callbacks that are not immediately invoked
          // except callbacks passed to non-route helpers; route-level nested functions (e.g. rollout async () => ...)
          // never gate route entry.
          if (
            n !== node &&
            (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
          ) {
            return;
          }

          if (ts.isBlock(n)) {
            const blockScope = curScope.child();
            for (const st of n.statements) {
              if (ts.isVariableStatement(st)) {
                const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
                for (const d of st.declarationList.declarations) {
                  if (d.initializer) walk(d.initializer, blockScope);
                  registerVarDeclaration(d, isConst, blockScope);
                }
              } else {
                walk(st, blockScope);
              }
            }
            return;
          }

          if (ts.isIfStatement(n)) {
            walk(n.expression, curScope);
            const c = evalCond(n.expression, curScope, method, candidate);
            if (c.value === true) {
              walk(n.thenStatement, curScope);
            } else if (c.value === false) {
              if (n.elseStatement) walk(n.elseStatement, curScope);
            } else {
              walk(n.thenStatement, curScope);
              if (n.elseStatement) walk(n.elseStatement, curScope);
            }
            return;
          }

          if (ts.isConditionalExpression(n)) {
            walk(n.condition, curScope);
            const c = evalCond(n.condition, curScope, method, candidate);
            if (c.value === true) {
              walk(n.whenTrue, curScope);
            } else if (c.value === false) {
              walk(n.whenFalse, curScope);
            } else {
              walk(n.whenTrue, curScope);
              walk(n.whenFalse, curScope);
            }
            return;
          }

          if (ts.isCallExpression(n)) {
            const callee = unwrapExpr(n.expression);
            if (ts.isIdentifier(callee)) {
              if (callee.text === 'requirePrivilege' && n.arguments.length >= 4) {
                for (const p of extractPrivStringsFromExpr(n.arguments[3], curScope, method, candidate)) {
                  acc.required.add(p);
                }
              } else if (callee.text === 'authorize' && n.arguments.length >= 1) {
                const arg0 = unwrapExpr(n.arguments[0]);
                if (ts.isObjectLiteralExpression(arg0)) {
                  for (const prop of arg0.properties) {
                    if (
                      ts.isPropertyAssignment(prop) &&
                      ((ts.isIdentifier(prop.name) && prop.name.text === 'privilege') ||
                        (ts.isStringLiteral(prop.name) && prop.name.text === 'privilege'))
                    ) {
                      for (const p of extractPrivStringsFromExpr(prop.initializer, curScope, method, candidate)) {
                        acc.authorized.add(p);
                      }
                    }
                  }
                }
              } else {
                const localFn = curScope.getLocalFn(callee.text);
                if (localFn && !visitedHelpers.has(localFn.key)) {
                  const fnScope = localFn.declScope.child();
                  localFn.params.forEach((paramName, idx) => {
                    if (paramName && idx < n.arguments.length) {
                      const argStr = extractStringConst(n.arguments[idx], curScope);
                      if (argStr !== undefined) fnScope.strings.set(paramName, argStr);
                    }
                  });
                  const nextVisited = new Set(visitedHelpers);
                  nextVisited.add(localFn.key);
                  collectPrivilegesFromNode(
                    localFn.body,
                    currentFile,
                    fnScope,
                    method,
                    candidate,
                    nextVisited,
                    acc,
                  );
                } else {
                  const helper = resolveHelper(currentFile, callee.text);
                  if (helper && !helper.hasMethodDispatch && !visitedHelpers.has(helper.key)) {
                    const helperScope = helper.fileScope.child();
                    helper.params.forEach((paramName, idx) => {
                      if (paramName && idx < n.arguments.length) {
                        const argStr = extractStringConst(n.arguments[idx], curScope);
                        if (argStr !== undefined) helperScope.strings.set(paramName, argStr);
                      }
                    });
                    const nextVisited = new Set(visitedHelpers);
                    nextVisited.add(helper.key);
                    collectPrivilegesFromNode(
                      helper.body,
                      helper.file,
                      helperScope,
                      method,
                      candidate,
                      nextVisited,
                      acc,
                    );
                  }
                }
              }
            }
          }

          ts.forEachChild(n, (child) => walk(child, curScope));
        }

        walk(node, scope);
      }

      function discoverCandidates(rootBody: ts.Node, baseScope: LexScope): PathCandidate[] {
        const candidates: PathCandidate[] = [];
        const seenKeys = new Set<string>();

        function addLiteral(lit: string) {
          if (!lit.startsWith('/')) return;
          const key = `lit:${lit}`;
          if (seenKeys.has(key)) return;
          seenKeys.add(key);
          candidates.push({ kind: 'literal', pattern: lit, canonical: lit, sample: lit });
        }

        function addRegex(reg: RegexInfo) {
          if (!reg.pattern.startsWith('^\\/') && !reg.pattern.startsWith('^/')) return;
          if (!reg.pattern.endsWith('$')) return;
          for (const branch of expandAlternations(reg.pattern)) {
            const key = `re:${branch}`;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            candidates.push({
              kind: 'regex',
              pattern: branch,
              origPattern: reg.pattern,
              flags: reg.flags,
              canonical: renderRegexBranch(branch, 'canonical'),
              sample: renderRegexBranch(branch, 'sample'),
            });
          }
        }

        function scanExprForPaths(expr: ts.Expression, scope: LexScope, seenIds = new Set<string>()): void {
          const e = unwrapExpr(expr);
          if (ts.isBinaryExpression(e)) {
            const op = e.operatorToken.kind;
            if (
              op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
              op === ts.SyntaxKind.EqualsEqualsToken ||
              op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
              op === ts.SyntaxKind.ExclamationEqualsToken
            ) {
              if (isRequestPathExpr(e.left, scope)) {
                const lit = extractStringConst(e.right, scope);
                if (lit) addLiteral(lit);
              }
              if (isRequestPathExpr(e.right, scope)) {
                const lit = extractStringConst(e.left, scope);
                if (lit) addLiteral(lit);
              }
            }
          }
          if (ts.isIdentifier(e) && !seenIds.has(e.text)) {
            const bound = scope.getExpr(e.text);
            if (bound) {
              const next = new Set(seenIds);
              next.add(e.text);
              scanExprForPaths(bound, scope, next);
            }
          }
          if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
            const prop = e.expression.name.text;
            const recv = e.expression.expression;
            if (prop === 'match' && isRequestPathExpr(recv, scope) && e.arguments.length >= 1) {
              const reg = extractRegexConst(e.arguments[0], scope);
              if (reg) addRegex(reg);
            }
            if (prop === 'test' && e.arguments.length >= 1 && isRequestPathExpr(e.arguments[0], scope)) {
              const reg = extractRegexConst(recv, scope);
              if (reg) addRegex(reg);
            }
            if (prop === 'includes' && e.arguments.length >= 1 && isRequestPathExpr(e.arguments[0], scope)) {
              const arr = extractStringArrayConst(recv, scope);
              if (arr) arr.forEach(addLiteral);
            }
          }
          ts.forEachChild(e, (child) => {
            if (ts.isExpression(child)) scanExprForPaths(child, scope, seenIds);
          });
        }

        function scanNode(n: ts.Node, scope: LexScope): void {
          if (
            n !== rootBody &&
            (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n))
          ) {
            return;
          }
          if (ts.isBlock(n)) {
            const childScope = scope.child();
            for (const st of n.statements) {
              scanNode(st, childScope);
            }
            return;
          }
          if (ts.isVariableStatement(n)) {
            const isConst = (n.declarationList.flags & ts.NodeFlags.Const) !== 0;
            for (const d of n.declarationList.declarations) {
              if (d.initializer) scanExprForPaths(d.initializer, scope);
              registerVarDeclaration(d, isConst, scope);
            }
            return;
          }
          if (ts.isExpression(n)) {
            scanExprForPaths(n, scope);
            return;
          }
          ts.forEachChild(n, (child) => scanNode(child, scope));
        }

        scanNode(rootBody, baseScope.child());
        return candidates;
      }

      function stmtWritesStatusCode(node: ts.Node, statusCode: number): boolean {
        let found = false;
        function walk(n: ts.Node) {
          if (found) return;
          if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
          if (ts.isCallExpression(n)) {
            const callee = unwrapExpr(n.expression);
            if (ts.isIdentifier(callee) && callee.text === 'json' && n.arguments.length >= 2) {
              const statusArg = unwrapExpr(n.arguments[1]);
              if (ts.isNumericLiteral(statusArg) && Number(statusArg.text) === statusCode) {
                found = true;
                return;
              }
            }
            if (
              ts.isPropertyAccessExpression(callee) &&
              callee.name.text === 'writeHead' &&
              n.arguments.length >= 1
            ) {
              const statusArg = unwrapExpr(n.arguments[0]);
              if (ts.isNumericLiteral(statusArg) && Number(statusArg.text) === statusCode) {
                found = true;
                return;
              }
            }
          }
          ts.forEachChild(n, walk);
        }
        walk(node);
        return found;
      }

      function stmtDestroysSocketWithoutHttpWrite(node: ts.Node): boolean {
        let hasDestroy = false;
        let hasWrite = false;
        function walk(n: ts.Node) {
          if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) return;
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
            const name = n.expression.name.text;
            const recv = unwrapExpr(n.expression.expression);
            if (ts.isIdentifier(recv) && recv.text === 'socket') {
              if (name === 'destroy') hasDestroy = true;
              if (name === 'write') hasWrite = true;
            }
          }
          ts.forEachChild(n, walk);
        }
        walk(node);
        return hasDestroy && !hasWrite;
      }

      function isReturnFalseExpr(expr: ts.Expression | undefined): boolean {
        if (!expr) return false;
        const e = unwrapExpr(expr);
        return e.kind === ts.SyntaxKind.FalseKeyword;
      }

      function isUnhandledEarlyExitBranch(stmt: ts.Statement): boolean {
        const stmts = ts.isBlock(stmt) ? [...stmt.statements] : [stmt];
        if (stmts.length === 0) return false;
        const last = stmts[stmts.length - 1];
        if (!ts.isReturnStatement(last)) return false;
        if (isReturnFalseExpr(last.expression)) return true;
        if (stmtWritesStatusCode(stmt, 405)) return true;
        if (stmtDestroysSocketWithoutHttpWrite(stmt)) return true;
        return false;
      }

      let currentFileRouteMap = new Map<string, DispatchedRoute>();

      function recordDispatched(
        file: string,
        method: HttpMethod,
        candidate: PathCandidate,
        privs: PrivAccumulator,
      ): void {
        const key = `${file}::${method}::${candidate.canonical}`;
        const existing = currentFileRouteMap.get(key);
        const reqList = [...privs.required];
        const authList = [...privs.authorized];
        const requiredPrivileges = dedupe([...(existing?.requiredPrivileges ?? []), ...reqList]).sort();
        const authorizedPrivileges = dedupe([...(existing?.authorizedPrivileges ?? []), ...authList]).sort();
        currentFileRouteMap.set(key, {
          method,
          pattern: existing?.pattern ?? candidate.pattern,
          canonical: candidate.canonical,
          sample: existing?.sample ?? candidate.sample,
          isRegex: existing?.isRegex ?? (candidate.kind === 'regex'),
          file,
          requiredPrivileges,
          authorizedPrivileges,
          enforcedPrivileges: dedupe([...requiredPrivileges, ...authorizedPrivileges]).sort(),
        });
      }

      type SimOutcome = 'returned-handled' | 'returned-unhandled' | 'fallthrough';

      function simulateStatementList(
        stmts: readonly ts.Statement[],
        file: string,
        scope: LexScope,
        method: HttpMethod,
        candidate: PathCandidate,
        initialPathConstrained: boolean,
        initialMethodConstrained: boolean,
        privs: PrivAccumulator,
      ): { outcome: SimOutcome; pathConstrained: boolean; methodConstrained: boolean } {
        let pathConstrained = initialPathConstrained;
        let methodConstrained = initialMethodConstrained;
        let saw405 = false;

        for (const stmt of stmts) {
          if (ts.isBlock(stmt)) {
            const sub = simulateStatementList(
              stmt.statements,
              file,
              scope.child(),
              method,
              candidate,
              pathConstrained,
              methodConstrained,
              privs,
            );
            pathConstrained = sub.pathConstrained;
            methodConstrained = sub.methodConstrained;
            if (sub.outcome !== 'fallthrough') {
              return { outcome: sub.outcome, pathConstrained, methodConstrained };
            }
            continue;
          }

          if (ts.isVariableStatement(stmt)) {
            const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
            for (const d of stmt.declarationList.declarations) {
              if (d.initializer) {
                collectPrivilegesFromNode(d.initializer, file, scope, method, candidate, new Set(), privs);
              }
              registerVarDeclaration(d, isConst, scope);
            }
            continue;
          }

          if (ts.isExpressionStatement(stmt)) {
            if (stmtWritesStatusCode(stmt, 405)) saw405 = true;
            collectPrivilegesFromNode(stmt.expression, file, scope, method, candidate, new Set(), privs);
            continue;
          }

          if (ts.isReturnStatement(stmt)) {
            if (isReturnFalseExpr(stmt.expression) || saw405 || !(pathConstrained && methodConstrained)) {
              return { outcome: 'returned-unhandled', pathConstrained, methodConstrained };
            }
            if (stmt.expression) {
              if (stmtWritesStatusCode(stmt.expression, 405)) {
                return { outcome: 'returned-unhandled', pathConstrained, methodConstrained };
              }
              collectPrivilegesFromNode(stmt.expression, file, scope, method, candidate, new Set(), privs);
            }
            recordDispatched(file, method, candidate, privs);
            return { outcome: 'returned-handled', pathConstrained, methodConstrained };
          }

          if (ts.isIfStatement(stmt)) {
            const cond = evalCond(stmt.expression, scope, method, candidate);

            if (cond.value === true) {
              collectPrivilegesFromNode(stmt.expression, file, scope, method, candidate, new Set(), privs);
              const nextPath = pathConstrained || cond.usedPath;
              const nextMethod = methodConstrained || cond.usedMethod;
              const branchPrivs: PrivAccumulator = {
                required: new Set(privs.required),
                authorized: new Set(privs.authorized),
              };
              const thenStmts = ts.isBlock(stmt.thenStatement) ? stmt.thenStatement.statements : [stmt.thenStatement];
              const sub = simulateStatementList(
                thenStmts,
                file,
                scope.child(),
                method,
                candidate,
                nextPath,
                nextMethod,
                branchPrivs,
              );
              if (sub.outcome !== 'fallthrough') {
                return { outcome: sub.outcome, pathConstrained: sub.pathConstrained, methodConstrained: sub.methodConstrained };
              }
              // Branch did not unconditionally return (e.g. conditional auth guard inside a route handler)
              pathConstrained = sub.pathConstrained;
              methodConstrained = sub.methodConstrained;
              for (const p of branchPrivs.required) privs.required.add(p);
              for (const p of branchPrivs.authorized) privs.authorized.add(p);
              // If an `if (path && method) { json(res, ...); }` snippet had no explicit `return`, record it if constrained
              if (pathConstrained && methodConstrained && !stmtWritesStatusCode(stmt.thenStatement, 405)) {
                let wroteResponse = false;
                const checkResp = (n: ts.Node) => {
                  if (ts.isCallExpression(n)) {
                    const callee = unwrapExpr(n.expression);
                    if (ts.isIdentifier(callee) && callee.text === 'json') wroteResponse = true;
                    if (
                      ts.isPropertyAccessExpression(callee) &&
                      ts.isIdentifier(callee.expression) &&
                      callee.expression.text === 'res' &&
                      (callee.name.text === 'end' || callee.name.text === 'writeHead')
                    ) {
                      wroteResponse = true;
                    }
                  }
                  ts.forEachChild(n, checkResp);
                };
                checkResp(stmt.thenStatement);
                if (wroteResponse) {
                  recordDispatched(file, method, candidate, privs);
                  return { outcome: 'returned-handled', pathConstrained, methodConstrained };
                }
              }
              continue;
            }

            if (cond.value === false) {
              if (isUnhandledEarlyExitBranch(stmt.thenStatement)) {
                pathConstrained = pathConstrained || cond.usedPath;
                methodConstrained = methodConstrained || cond.usedMethod;
              }
              if (stmt.elseStatement) {
                const elseStmts = ts.isBlock(stmt.elseStatement) ? stmt.elseStatement.statements : [stmt.elseStatement];
                const sub = simulateStatementList(
                  elseStmts,
                  file,
                  scope.child(),
                  method,
                  candidate,
                  pathConstrained,
                  methodConstrained,
                  privs,
                );
                pathConstrained = sub.pathConstrained;
                methodConstrained = sub.methodConstrained;
                if (sub.outcome !== 'fallthrough') {
                  return { outcome: sub.outcome, pathConstrained, methodConstrained };
                }
              }
              continue;
            }

            // cond.value === 'unknown': runtime condition (e.g. `if (!principal) return`, `if (who.ok) ...`, `if (body.force) ...`)
            collectPrivilegesFromNode(stmt.expression, file, scope, method, candidate, new Set(), privs);
            if (pathConstrained && methodConstrained) {
              collectPrivilegesFromNode(stmt.thenStatement, file, scope, method, candidate, new Set(), privs);
              if (stmt.elseStatement) {
                collectPrivilegesFromNode(stmt.elseStatement, file, scope, method, candidate, new Set(), privs);
              }
            } else {
              // Explore nested blocks in case routes are dispatched inside a runtime guard
              const thenStmts = ts.isBlock(stmt.thenStatement) ? stmt.thenStatement.statements : [stmt.thenStatement];
              simulateStatementList(
                thenStmts,
                file,
                scope.child(),
                method,
                candidate,
                pathConstrained,
                methodConstrained,
                { required: new Set(privs.required), authorized: new Set(privs.authorized) },
              );
              if (stmt.elseStatement) {
                const elseStmts = ts.isBlock(stmt.elseStatement) ? stmt.elseStatement.statements : [stmt.elseStatement];
                simulateStatementList(
                  elseStmts,
                  file,
                  scope.child(),
                  method,
                  candidate,
                  pathConstrained,
                  methodConstrained,
                  { required: new Set(privs.required), authorized: new Set(privs.authorized) },
                );
              }
            }
            continue;
          }

          // TryStatement / ForOfStatement / SwitchStatement / etc.: collect privileges inside when already in route handler
          collectPrivilegesFromNode(stmt, file, scope, method, candidate, new Set(), privs);
        }

        return { outcome: saw405 ? 'returned-unhandled' : 'fallthrough', pathConstrained, methodConstrained };
      }

      function analyzeHandlerBody(
        body: ts.Block,
        file: string,
        parentScope: LexScope,
        paramNames: readonly string[],
        options: { isUpgrade?: boolean },
      ): void {
        const initScope = parentScope.child();
        for (const p of paramNames) {
          if (p === 'path' || p === 'pathname') initScope.pathVars.add(p);
        }
        if (paramNames.length === 0) {
          // Inline snippet support (e.g. unit tests passing bare statements)
          initScope.pathVars.add('path');
          initScope.pathVars.add('pathname');
        }

        const candidates = discoverCandidates(body, initScope);
        if (candidates.length === 0) return;

        const methods: readonly HttpMethod[] = options.isUpgrade ? ['GET'] : ALL_METHODS;
        for (const candidate of candidates) {
          for (const method of methods) {
            const privs: PrivAccumulator = { required: new Set(), authorized: new Set() };
            const res = simulateStatementList(
              body.statements,
              file,
              initScope.child(),
              method,
              candidate,
              false,
              Boolean(options.isUpgrade),
              privs,
            );
            if (res.outcome === 'fallthrough' && res.pathConstrained && res.methodConstrained) {
              recordDispatched(file, method, candidate, privs);
            }
          }
        }
      }

      function helperDepSignature(startFile: string): string {
        const visited = new Set<string>();
        const parts: string[] = [];
        function visit(f: string) {
          if (visited.has(f)) return;
          visited.add(f);
          const u = unitByFile.get(f);
          if (!u) return;
          parts.push(`${f}:${u.src.length}:${u.src}`);
          const imps = importedHelpers.get(f);
          if (imps) {
            for (const { targetFile, exportedName } of imps.values()) {
              const targetHelper = exportedHelpers.get(targetFile)?.get(exportedName);
              if (targetHelper && !targetHelper.hasMethodDispatch) {
                visit(targetFile);
              }
            }
          }
        }
        visit(startFile);
        return parts.join('\0');
      }

      const allRoutes: DispatchedRoute[] = [];

      for (const p of parsedUnits) {
        const cacheable = p.file !== 'inline.ts';
        const sig = cacheable ? helperDepSignature(p.file) : '';
        const cached = cacheable ? unitRouteCache.get(p.file) : undefined;
        if (cached && cached.sig === sig) {
          allRoutes.push(...cached.routes);
          continue;
        }

        currentFileRouteMap = new Map<string, DispatchedRoute>();
        const upgradeCallbacks = new Set<ts.Node>();

        function walkUnit(n: ts.Node): void {
          // 1. WebSocket upgrade handlers: `<server>.on('upgrade', (req, socket, head) => { ... })`
          if (
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === 'on' &&
            n.arguments.length >= 2
          ) {
            const evName = extractStringConst(n.arguments[0], p.fileScope);
            const cb = n.arguments[1];
            if (
              evName === 'upgrade' &&
              (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) &&
              ts.isBlock(cb.body)
            ) {
              upgradeCallbacks.add(cb);
              const params = cb.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : ''));
              analyzeHandlerBody(cb.body, p.file, p.fileScope, params, { isUpgrade: true });
            }
          }

          // 2. HTTP route functions (`function route(...)`, `export async function handle*(...)`, server callbacks)
          if (
            (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
            !upgradeCallbacks.has(n) &&
            n.body &&
            ts.isBlock(n.body)
          ) {
            const params = n.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : ''));
            if (params.includes('req') || params.includes('res')) {
              analyzeHandlerBody(n.body, p.file, p.fileScope, params, { isUpgrade: false });
            }
          }

          ts.forEachChild(n, walkUnit);
        }

        walkUnit(p.sf);

        // 3. Top-level control-flow statements for standalone snippet tests
        if (p.sf.statements.some((s) => ts.isIfStatement(s))) {
          const pseudoBlock = ts.factory.createBlock([...p.sf.statements], true);
          analyzeHandlerBody(pseudoBlock, p.file, p.fileScope, [], { isUpgrade: false });
        }

        const unitRoutes = [...currentFileRouteMap.values()];
        if (cacheable) {
          unitRouteCache.set(p.file, { sig, routes: unitRoutes });
        }
        allRoutes.push(...unitRoutes);
      }

      return allRoutes;
    }

    function extractDispatched(src: string, fileName = 'inline.ts'): DispatchedRoute[] {
      return analyzeControlPlane([{ file: fileName, src }]);
    }

    function findUnregisteredRoutes(
      dispatched: readonly DispatchedRoute[],
      registry: readonly ControlPlaneRoute[] = CONTROL_PLANE_ROUTES,
    ): string[] {
      const unhandled: string[] = [];
      for (const ext of dispatched) {
        const matches = registry.some(
          (r) => r.method === ext.method && canonicalizeRegistryPattern(r.pattern) === ext.canonical,
        );
        if (!matches) {
          unhandled.push(`${ext.file ?? 'inline'}: ${ext.method} ${ext.canonical} (${ext.pattern})`);
        }
      }
      return unhandled;
    }

    function findStaleRoutes(
      dispatched: readonly DispatchedRoute[],
      registry: readonly ControlPlaneRoute[] = CONTROL_PLANE_ROUTES,
    ): string[] {
      const stale: string[] = [];
      for (const r of registry) {
        const canon = canonicalizeRegistryPattern(r.pattern);
        const matched = dispatched.some((ext) => ext.method === r.method && ext.canonical === canon);
        if (!matched) {
          stale.push(`${r.method} ${r.pattern} (canonical: ${canon})`);
        }
      }
      return stale;
    }

    function findPrivilegeEnforcementViolations(
      dispatched: readonly DispatchedRoute[],
      registry: readonly ControlPlaneRoute[] = CONTROL_PLANE_ROUTES,
    ): string[] {
      const violations: string[] = [];
      for (const r of registry) {
        if (!r.privilege) continue;
        const declared = getRoutePrivileges(r);
        const declaredSet = new Set<string>(declared);
        const canon = canonicalizeRegistryPattern(r.pattern);
        const matchingHandlers = dispatched.filter((ext) => ext.method === r.method && ext.canonical === canon);

        if (matchingHandlers.length === 0) {
          violations.push(`${r.method} ${r.pattern}: no matching dispatched handler found in control-plane AST`);
          continue;
        }

        for (const h of matchingHandlers) {
          const required = new Set(h.requiredPrivileges);
          const enforced = new Set(h.enforcedPrivileges);
          const loc = h.file ? ` (${h.file})` : '';

          if (enforced.size === 0) {
            violations.push(
              `${r.method} ${r.pattern}${loc}: declares privilege [${declared.join(', ')}] but handler enforces no Bouncer privilege`,
            );
            continue;
          }

          for (const p of declared) {
            if (!enforced.has(p)) {
              violations.push(
                `${r.method} ${r.pattern}${loc}: declares privilege '${p}', but handler only enforces [${[...enforced].join(', ')}]`,
              );
            }
          }

          for (const reqPriv of required) {
            const writeUpgrade = reqPriv.endsWith('.read') && declaredSet.has(reqPriv.replace(/\.read$/, '.write'));
            if (!declaredSet.has(reqPriv) && !writeUpgrade) {
              violations.push(
                `${r.method} ${r.pattern}${loc}: handler calls requirePrivilege('${reqPriv}'), which is missing from declared privilege [${declared.join(', ')}]`,
              );
            }
          }
        }
      }
      return violations;
    }

    function controlPlaneUnits(): SourceUnit[] {
      return controlPlane().map((f) => ({ file: f, src: read(f) }));
    }

    let cachedProdDispatched: DispatchedRoute[] | undefined;
    function productionDispatched(): DispatchedRoute[] {
      if (!cachedProdDispatched) {
        cachedProdDispatched = analyzeControlPlane(controlPlaneUnits());
      }
      return cachedProdDispatched;
    }

    it('AC1: any route in control plane lacking either a Bouncer privilege or an entry in ROUTE_EXCEPTIONS fails CI', () => {
      // 1. In-memory validation failure test
      const syntheticUnprivileged: ControlPlaneRoute[] = [
        ...CONTROL_PLANE_ROUTES,
        {
          method: 'GET',
          pattern: '/api/v1/synthetic/unprotected/test-route',
          description: 'Synthetic route with neither privilege nor exception',
        } as unknown as ControlPlaneRoute,
      ];
      const { valid, errors } = validateRouteRegistry(syntheticUnprivileged, ROUTE_EXCEPTIONS);
      assert.equal(valid, false, 'Expected validation to fail for unprivileged route without exception');
      assert.ok(errors.length > 0, 'Expected validation errors');
      assert.ok(
        errors.some((e) => e.includes("Route 'GET /api/v1/synthetic/unprotected/test-route' must declare either a Bouncer privilege or reference an entry in ROUTE_EXCEPTIONS")),
        `Expected unprivileged route error, got: ${errors.join('; ')}`
      );

      // 2. Source-level guard test: asserting that if control-plane source introduces an unprivileged route,
      // it is detected by source extraction and rejected by the route registry.
      const syntheticSourcePostUi = `
        if (path === '/ui' && req.method === 'POST') {
          json(res, 200, { unauthenticated: true });
          return;
        }
      `;
      const extractedPostUi = extractDispatched(syntheticSourcePostUi);
      assert.equal(extractedPostUi.length, 1);
      assert.equal(findUnregisteredRoutes(extractedPostUi).length, 1, 'Injected POST /ui must not be covered by CONTROL_PLANE_ROUTES');

      const syntheticSourceRogue = `
        if (path === '/api/v1/rogue-endpoint' && req.method === 'GET') {
          json(res, 200, { rogue: true });
          return;
        }
      `;
      const extractedRogue = extractDispatched(syntheticSourceRogue);
      assert.equal(extractedRogue.length, 1);
      assert.equal(findUnregisteredRoutes(extractedRogue).length, 1, 'Injected GET /api/v1/rogue-endpoint must not be covered by CONTROL_PLANE_ROUTES');

      const syntheticSourceNuke = `
        const killMatch = path.match(/^\\/api\\/v1\\/agents\\/([^/]+)\\/(pause|resume|isolate|nuke)$/);
        if (killMatch && req.method === 'POST') {
          return true;
        }
      `;
      const extractedNuke = extractDispatched(syntheticSourceNuke);
      const nukeBranch = extractedNuke.find((ext) => ext.pattern.endsWith('/nuke$'));
      assert.ok(nukeBranch, 'Expected nuke alternation branch to be extracted');
      const matchesNuke = CONTROL_PLANE_ROUTES.some(
        (r) => r.method === nukeBranch.method && new RegExp(nukeBranch.pattern).test(samplePath(r.pattern))
      );
      assert.equal(matchesNuke, false, 'Injected nuke branch must not be covered by CONTROL_PLANE_ROUTES');

      // Array membership method check (`['POST', 'DELETE'].includes(req.method)`) and `REGEX.test(pathname)`
      const syntheticArrayAndTest = `
        const SECRET_RE = /^\\/api\\/v1\\/secret\\/([^/]+)$/;
        export async function handleSecret(state: unknown, req: { method?: string }, res: unknown, pathname: string): Promise<boolean> {
          if (!SECRET_RE.test(pathname) || !['POST', 'DELETE'].includes(req.method ?? '')) return false;
          return true;
        }
      `;
      const extractedArray = extractDispatched(syntheticArrayAndTest);
      assert.deepEqual(
        extractedArray.map((r) => `${r.method} ${r.canonical}`).sort(),
        ['DELETE /api/v1/secret/:param', 'POST /api/v1/secret/:param'],
      );
    });

    it('every route in CONTROL_PLANE_ROUTES has a valid privilege or registered exception', () => {
      const { valid, errors } = validateRouteRegistry(CONTROL_PLANE_ROUTES, ROUTE_EXCEPTIONS);
      assert.equal(valid, true, `Route registry validation failed: ${errors.join(', ')}`);
      assert.deepEqual(errors, []);
    });

    it('every registered exception has valid protection mechanism, non-empty rationale, and retiringStory/plannedIn matching /^S\\d+[a-z]?$/', () => {
      for (const [id, exc] of Object.entries(ROUTE_EXCEPTIONS)) {
        assert.ok(exc.protection, `Exception ${id} must specify protection mechanism`);
        assert.ok(exc.rationale && exc.rationale.trim().length > 0, `Exception ${id} must specify non-empty rationale`);
        if (exc.protection === 'transitional') {
          assert.ok(exc.retiringStory, `Transitional exception ${id} must specify retiringStory`);
          assert.match(exc.retiringStory, /^S\d+[a-z]?$/, `Transitional exception ${id} retiringStory must match S<number>[suffix]`);
        }
        if (exc.plannedIn) {
          assert.match(exc.plannedIn, /^S\d+[a-z]?$/, `Exception ${id} plannedIn must match S<number>[suffix]`);
        }
      }
    });

    it('every exception in ROUTE_EXCEPTIONS without plannedIn is referenced by at least one route in CONTROL_PLANE_ROUTES', () => {
      const referencedExceptions = new Set(
        CONTROL_PLANE_ROUTES.map((r) => r.exception).filter((e): e is NonNullable<typeof e> => Boolean(e))
      );
      const unreferenced: string[] = [];
      for (const [id, exc] of Object.entries(ROUTE_EXCEPTIONS)) {
        if (!exc.plannedIn && !referencedExceptions.has(id as any)) {
          unreferenced.push(id);
        }
      }
      assert.deepEqual(unreferenced, [], 'Exceptions without plannedIn must be referenced by at least one route');
    });

    it('fails conformance when a route references an unknown exception', () => {
      const badExceptionRoute: ControlPlaneRoute[] = [
        ...CONTROL_PLANE_ROUTES,
        {
          method: 'GET',
          pattern: '/api/v1/bad-exception-test',
          exception: 'unknown-exception-id' as any,
          description: 'Bad exception test',
        } as unknown as ControlPlaneRoute,
      ];
      const { valid, errors } = validateRouteRegistry(badExceptionRoute, ROUTE_EXCEPTIONS);
      assert.equal(valid, false, 'Expected validation to fail');
      assert.ok(errors.some((e) => e.includes("references unknown exception 'unknown-exception-id'")));
    });

    it('every route handled by control-plane dispatchers matches a row in CONTROL_PLANE_ROUTES', () => {
      const dispatched = productionDispatched();
      const unhandled = findUnregisteredRoutes(dispatched);
      assert.deepEqual(unhandled, [], 'Dispatched route in control plane not covered by CONTROL_PLANE_ROUTES');
    });

    it('every row in CONTROL_PLANE_ROUTES corresponds to an actual route in control-plane code (no stale table entries)', () => {
      const dispatched = productionDispatched();
      const staleRoutes = findStaleRoutes(dispatched);
      assert.deepEqual(staleRoutes, [], 'Stale route in CONTROL_PLANE_ROUTES not found in control-plane source');
    });

    it('every route declaring privilege corresponds to actual requirePrivilege or authorize enforcement in its own handler', () => {
      const dispatched = productionDispatched();
      const violations = findPrivilegeEnforcementViolations(dispatched);
      assert.deepEqual(violations, [], 'Route privilege declaration does not match handler privilege enforcement');
    });

    describe('source-mutation regressions on real control-plane modules (F1 & F2)', () => {
      it('appending an unregistered alternation branch to runSelf in app.ts fails unregistered-route check', () => {
        const units = controlPlaneUnits().map((u) => {
          if (!u.file.endsWith('/app.ts')) return u;
          const mutated = u.src.replace(
            '(input|result|heartbeat|mailbox|training|reply|agent-config|role-requests|builder)',
            '(input|result|heartbeat|mailbox|training|reply|agent-config|role-requests|builder|nuke)',
          );
          assert.notEqual(mutated, u.src, 'Expected runSelf regex in app.ts to be mutated');
          return { file: u.file, src: mutated };
        });

        const unhandled = findUnregisteredRoutes(analyzeControlPlane(units));
        assert.ok(
          unhandled.some((u) => u.includes('POST /api/v1/runs/:param/nuke')),
          `Expected POST /api/v1/runs/:param/nuke to be flagged unregistered, got: ${unhandled.join('; ')}`,
        );
      });

      it('injecting an unregistered/unprivileged route into group-routes.ts fails unregistered and privilege checks', () => {
        const units = controlPlaneUnits().map((u) => {
          if (!u.file.endsWith('/group-routes.ts')) return u;
          const target = "if (!pathname.startsWith('/api/v1/groups')) return false;";
          const mutated = u.src.replace(
            target,
            `${target}\n  if (req.method === 'POST' && pathname === '/api/v1/groups/secret') { json(res, 200, { ok: true }); return true; }`,
          );
          assert.notEqual(mutated, u.src, 'Expected group-routes.ts to be mutated');
          return { file: u.file, src: mutated };
        });

        const dispatched = analyzeControlPlane(units);
        const unhandled = findUnregisteredRoutes(dispatched);
        assert.ok(
          unhandled.some((u) => u.includes('POST /api/v1/groups/secret')),
          `Expected POST /api/v1/groups/secret to be flagged unregistered, got: ${unhandled.join('; ')}`,
        );

        // Even if someone added POST /api/v1/groups/secret to CONTROL_PLANE_ROUTES claiming 'agents.read',
        // per-route handler privilege verification rejects it because the handler enforces no privilege.
        const registryWithClaim: ControlPlaneRoute[] = [
          ...CONTROL_PLANE_ROUTES,
          { method: 'POST', pattern: '/api/v1/groups/secret', privilege: 'agents.read', description: 'Fake claim' },
        ];
        const privViolations = findPrivilegeEnforcementViolations(dispatched, registryWithClaim);
        assert.ok(
          privViolations.some((v) => v.includes('POST /api/v1/groups/secret') && v.includes('enforces no Bouncer privilege')),
          `Expected unguarded handler violation, got: ${privViolations.join('; ')}`,
        );
      });

      it('deleting an existing route branch from group-routes.ts fails stale-route check', () => {
        const units = controlPlaneUnits().map((u) => {
          if (!u.file.endsWith('/group-routes.ts')) return u;
          const mutated = u.src.replace(
            /if \(GROUP_BASE\.test\(pathname\)\) \{\s*if \(req\.method === 'GET'\) \{[\s\S]*?return json\(res, 200, \{ groups \}\), true;\s*\}/,
            'if (GROUP_BASE.test(pathname)) {',
          );
          assert.notEqual(mutated, u.src, 'Expected GET /api/v1/groups branch in group-routes.ts to be deleted');
          return { file: u.file, src: mutated };
        });

        const stale = findStaleRoutes(analyzeControlPlane(units));
        assert.ok(
          stale.some((s) => s.startsWith('GET /api/v1/groups ')),
          `Expected GET /api/v1/groups to be flagged as stale, got: ${stale.join('; ')}`,
        );
      });

      it('changing or omitting requirePrivilege in group-routes.ts fails per-route privilege check', () => {
        // 1. Wrong privilege enforced in handler ('agents.read' instead of 'groups.manage')
        const wrongPrivUnits = controlPlaneUnits().map((u) => {
          if (!u.file.endsWith('/group-routes.ts')) return u;
          const mutated = u.src.replace(
            "requirePrivilege(req, res, state, 'groups.manage')",
            "requirePrivilege(req, res, state, 'agents.read')",
          );
          assert.notEqual(mutated, u.src, 'Expected first requirePrivilege in group-routes.ts to be mutated');
          return { file: u.file, src: mutated };
        });
        const wrongPrivViolations = findPrivilegeEnforcementViolations(analyzeControlPlane(wrongPrivUnits));
        assert.ok(
          wrongPrivViolations.some((v) => v.startsWith('GET /api/v1/groups ') && v.includes("declares privilege 'groups.manage'")),
          `Expected privilege mismatch on GET /api/v1/groups, got: ${wrongPrivViolations.join('; ')}`,
        );

        // 2. Omitting requirePrivilege completely on GET /api/v1/groups
        const omittedUnits = controlPlaneUnits().map((u) => {
          if (!u.file.endsWith('/group-routes.ts')) return u;
          const mutated = u.src.replace(
            "const principal = await requirePrivilege(req, res, state, 'groups.manage');\n      if (!principal) return true;",
            '// omitted auth check',
          );
          assert.notEqual(mutated, u.src, 'Expected first requirePrivilege guard in group-routes.ts to be removed');
          return { file: u.file, src: mutated };
        });
        const omittedViolations = findPrivilegeEnforcementViolations(analyzeControlPlane(omittedUnits));
        assert.ok(
          omittedViolations.some((v) => v.startsWith('GET /api/v1/groups ') && v.includes('enforces no Bouncer privilege')),
          `Expected missing enforcement violation on GET /api/v1/groups, got: ${omittedViolations.join('; ')}`,
        );
      });

      it('isolates lexical scopes when sibling functions reuse identifier names like m and ROUTE', () => {
        const siblingScopeSrc = `
          export async function handleAlpha(state: unknown, req: { method?: string }, res: unknown, path: string): Promise<boolean> {
            const ROUTE = '/api/v1/alpha';
            if (req.method === 'GET' && path === ROUTE) {
              const principal = await requirePrivilege(req, res, state, 'agents.read');
              if (!principal) return true;
              return true;
            }
            const m = path.match(/^\\/api\\/v1\\/alpha\\/([^/]+)$/);
            if (!m || req.method !== 'DELETE') return false;
            const principal = await requirePrivilege(req, res, state, 'agents.purge');
            if (!principal) return true;
            return true;
          }

          export async function handleBeta(state: unknown, req: { method?: string }, res: unknown, path: string): Promise<boolean> {
            const ROUTE = '/api/v1/beta';
            if (req.method === 'POST' && path === ROUTE) {
              const principal = await requirePrivilege(req, res, state, 'groups.manage');
              if (!principal) return true;
              return true;
            }
            const m = path.match(/^\\/api\\/v1\\/beta\\/([^/]+)$/);
            if (!m || req.method !== 'PUT') return false;
            const principal = await requirePrivilege(req, res, state, 'skills.decide');
            if (!principal) return true;
            return true;
          }
        `;
        const extracted = extractDispatched(siblingScopeSrc);
        assert.deepEqual(
          extracted.map((r) => `${r.method} ${r.canonical} [${r.enforcedPrivileges.join(',')}]`).sort(),
          [
            'DELETE /api/v1/alpha/:param [agents.purge]',
            'GET /api/v1/alpha [agents.read]',
            'POST /api/v1/beta [groups.manage]',
            'PUT /api/v1/beta/:param [skills.decide]',
          ],
        );
      });

      it('extracts WebSocket upgrade routes strictly from .on("upgrade", ...) AST callbacks without substring false positives', () => {
        const dispatched = productionDispatched();
        const fromAgentCreation = dispatched.filter((r) => r.file?.endsWith('/agent-creation.ts'));
        assert.equal(
          fromAgentCreation.some((r) => r.method === 'GET' && r.canonical === '/api/v1/agents'),
          false,
          'agent-creation.ts (which contains "runtime-upgrade") must not falsely emit GET /api/v1/agents',
        );
        assert.deepEqual(
          fromAgentCreation.map((r) => `${r.method} ${r.canonical}`).sort(),
          ['GET /api/v1/runtime', 'POST /api/v1/agents', 'POST /api/v1/agents/:param/convert', 'PUT /api/v1/runtime'],
        );

        const fromStream = dispatched.filter((r) => r.file?.endsWith('/stream.ts'));
        assert.deepEqual(
          fromStream.map((r) => `${r.method} ${r.canonical} [${r.enforcedPrivileges.join(',')}]`),
          ['GET /api/v1/events [events.subscribe]'],
        );
      });
    });
  });
});
