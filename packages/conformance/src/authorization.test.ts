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
    function findMatchingParen(pattern: string, open: number): number {
      let depth = 0;
      for (let i = open; i < pattern.length; i++) {
        if (pattern[i] === '\\' && i + 1 < pattern.length) {
          i++;
          continue;
        }
        if (pattern[i] === '(') depth++;
        else if (pattern[i] === ')' && --depth === 0) return i;
      }
      return -1;
    }

    function expandAlternations(pattern: string): string[] {
      const qmark = pattern.indexOf('(?:');
      if (qmark !== -1) {
        const close = findMatchingParen(pattern, qmark);
        if (close !== -1 && pattern[close + 1] === '?') {
          const prefix = pattern.slice(0, qmark);
          const suffix = pattern.slice(close + 2);
          const inner = pattern.slice(qmark + 3, close);
          return [
            ...expandAlternations(prefix + suffix),
            ...expandAlternations(prefix + inner + suffix),
          ];
        }
      }

      for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === '(') {
          const close = findMatchingParen(pattern, i);
          if (close !== -1) {
            const inner = pattern.slice(i + 1, close);
            let depth = 0;
            let hasPipe = false;
            const branches: string[] = [];
            let cur = '';
            const start = inner.startsWith('?:') ? 2 : 0;
            for (let j = start; j < inner.length; j++) {
              if (inner[j] === '\\' && j + 1 < inner.length) {
                cur += inner[j] + inner[j + 1];
                j++;
                continue;
              }
              if (inner[j] === '(') depth++;
              else if (inner[j] === ')') depth--;
              else if (inner[j] === '|' && depth === 0) {
                hasPipe = true;
                branches.push(cur);
                cur = '';
                continue;
              }
              cur += inner[j];
            }
            branches.push(cur);
            if (hasPipe) {
              const prefix = pattern.slice(0, i);
              const suffix = pattern.slice(close + 1);
              const res: string[] = [];
              for (const b of branches) {
                res.push(...expandAlternations(prefix + b + suffix));
              }
              return res;
            }
          }
        }
      }

      return [pattern];
    }

    type DispatchedRoute = {
      method: HttpMethod;
      pattern: string;
      isRegex: boolean;
      file?: string;
    };

    function samplePath(pattern: string): string {
      return pattern
        .replace(/:version\b/g, '1')
        .replace(/:provider\b/g, 'p')
        .replace(/:subject\b/g, 's')
        .replace(/:step\b/g, 's')
        .replace(/:skillId\b/g, 'x')
        .replace(/:targetAgentId\b/g, 't')
        .replace(/:subagentRunId\b/g, 's')
        .replace(/:model\b/g, 'm')
        .replace(/:member\b/g, 'm')
        .replace(/:channel\b/g, 'c')
        .replace(/:name\b/g, 'n')
        .replace(/:id\b/g, 'x')
        .replace(/:[a-zA-Z0-9_]+/g, 'x');
    }

    function extractDispatched(src: string, fileName?: string): DispatchedRoute[] {
      const routes: DispatchedRoute[] = [];
      const sf = ts.createSourceFile(fileName || 'file.ts', src, ts.ScriptTarget.Latest, true);

      const pathConsts = new Map<string, string>();
      const regexConsts = new Map<string, string>();
      const matchVars = new Map<string, { pattern: string; isRegex: boolean }>();
      const boolVars = new Map<string, string[]>();

      function extractStringLiteral(node: ts.Node): string | undefined {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (node.text.startsWith('/')) return node.text;
        }
        return undefined;
      }

      function extractRegexLiteral(node: ts.Node): string | undefined {
        if (ts.isRegularExpressionLiteral(node)) {
          const text = node.text;
          const m = text.match(/^\/(.*)\/([a-z]*)$/s);
          if (m) return m[1];
        }
        return undefined;
      }

      function addRoute(method: HttpMethod, pattern: string, isRegex: boolean) {
        if (isRegex) {
          const expanded = expandAlternations(pattern);
          for (const p of expanded) {
            if (!routes.some((r) => r.method === method && r.pattern === p)) {
              routes.push({ method, pattern: p, isRegex: true, file: fileName });
            }
          }
        } else {
          if (!routes.some((r) => r.method === method && r.pattern === pattern)) {
            routes.push({ method, pattern, isRegex: false, file: fileName });
          }
        }
      }

      function prePass(node: ts.Node) {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const name = node.name.text;
          const str = extractStringLiteral(node.initializer);
          if (str) {
            pathConsts.set(name, str);
          }
          const reg = extractRegexLiteral(node.initializer);
          if (reg) {
            regexConsts.set(name, reg);
          }
          if (ts.isCallExpression(node.initializer)) {
            const call = node.initializer;
            const expr = call.expression;
            if (ts.isPropertyAccessExpression(expr)) {
              const prop = expr.name.text;
              const obj = expr.expression.getText(sf);
              if ((obj === 'path' || obj === 'pathname') && prop === 'match' && call.arguments.length > 0) {
                const arg = call.arguments[0];
                const argReg = extractRegexLiteral(arg);
                if (argReg) {
                  matchVars.set(name, { pattern: argReg, isRegex: true });
                } else if (ts.isIdentifier(arg)) {
                  const constReg = regexConsts.get(arg.text);
                  if (constReg) matchVars.set(name, { pattern: constReg, isRegex: true });
                  const constStr = pathConsts.get(arg.text);
                  if (constStr) matchVars.set(name, { pattern: constStr, isRegex: false });
                }
              }
            }
          }
          if (ts.isBinaryExpression(node.initializer) && node.initializer.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
            const paths: string[] = [];
            function collectOrPaths(e: ts.Expression) {
              if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                collectOrPaths(e.left);
                collectOrPaths(e.right);
              } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
                const l = e.left.getText(sf);
                const r = extractStringLiteral(e.right);
                if ((l === 'path' || l === 'pathname') && r) paths.push(r);
              }
            }
            collectOrPaths(node.initializer);
            if (paths.length > 0) {
              boolVars.set(name, paths);
            }
          }
        }
        ts.forEachChild(node, prePass);
      }
      prePass(sf);

      // WebSocket upgrade route: url.pathname !== '/api/v1/events'
      for (const m of src.matchAll(/\b(?:url\.pathname|pathname|path)\s*!==\s*['"`](\/[^'"`\n]*)['"`]/g)) {
        if (src.includes('upgrade') || src.includes('attachEventStream')) {
          addRoute('GET', m[1], false);
        }
      }

      // Schedules allow-list:
      if (src.includes('/api/v1/schedules')) {
        addRoute('GET', '/api/v1/schedules', false);
        addRoute('POST', '/api/v1/schedules', false);
        const oneReg = '^\\/api\\/v1\\/schedules\\/([^/]+)$';
        addRoute('POST', oneReg, true);
        addRoute('PUT', oneReg, true);
        addRoute('PATCH', oneReg, true);
        addRoute('DELETE', oneReg, true);
      }

      // Credentials:
      if (src.includes('/api/v1/keymaster/agents/') && src.includes('credentials')) {
        addRoute('GET', '^\\/api\\/v1\\/keymaster\\/agents\\/([^/]+)\\/credentials$', true);
        addRoute('POST', '^\\/api\\/v1\\/keymaster\\/agents\\/([^/]+)\\/credentials\\/([^/]+)$', true);
        addRoute('PUT', '^\\/api\\/v1\\/keymaster\\/agents\\/([^/]+)\\/credentials\\/([^/]+)$', true);
      }

      // Discord App:
      if (src.includes('discord-app')) {
        addRoute('GET', '^\\/api\\/v1\\/keymaster\\/agents\\/([a-z0-9-]+)\\/discord-app$', true);
        addRoute('POST', '^\\/api\\/v1\\/keymaster\\/agents\\/([a-z0-9-]+)\\/discord-app\\/token$', true);
      }

      // Group Routes:
      if (src.includes('handleGroupRoutes')) {
        addRoute('GET', '^\\/api\\/v1\\/groups$', true);
        addRoute('POST', '^\\/api\\/v1\\/groups$', true);
        addRoute('GET', '^\\/api\\/v1\\/groups\\/([^/]+)$', true);
        addRoute('PUT', '^\\/api\\/v1\\/groups\\/([^/]+)$', true);
        addRoute('DELETE', '^\\/api\\/v1\\/groups\\/([^/]+)$', true);
        addRoute('POST', '^\\/api\\/v1\\/groups\\/([^/]+)\\/members$', true);
        addRoute('DELETE', '^\\/api\\/v1\\/groups\\/([^/]+)\\/members$', true);
        addRoute('DELETE', '^\\/api\\/v1\\/groups\\/([^/]+)\\/members\\/([^/]+)$', true);
      }

      // Config Store:
      if (src.includes('handleConfig')) {
        addRoute('PUT', '^\\/api\\/v1\\/agents\\/([^/]+)\\/owners$', true);
        addRoute('GET', '^\\/api\\/v1\\/agents\\/([^/]+)\\/config$', true);
        addRoute('GET', '^\\/api\\/v1\\/agents\\/([^/]+)\\/config\\/history$', true);
        addRoute('GET', '^\\/api\\/v1\\/agents\\/([^/]+)\\/config\\/versions\\/([^/]+)$', true);
        addRoute('GET', '/api/v1/config/export', false);
      }

      // Skills GET section:
      if (src.includes("req.method !== 'GET'") && src.includes('PACKAGE_FILES')) {
        for (const name of ['PACKAGE_FILES', 'PACKAGE_FILE', 'ADOPTERS', 'ONE_SKILL', 'ONE_VERSION']) {
          const reg = regexConsts.get(name);
          if (reg) addRoute('GET', reg, true);
        }
        addRoute('GET', '/api/v1/skills', false);
      }

      // Agent Creation:
      if (src.includes('/api/v1/runtime')) {
        addRoute('GET', '/api/v1/runtime', false);
        addRoute('PUT', '/api/v1/runtime', false);
      }
      if (src.includes('/convert')) {
        addRoute('POST', '^\\/api\\/v1\\/agents\\/([^/]+)\\/convert$', true);
      }

      // Channel Approvals:
      if (src.includes('handleChannelApprovals')) {
        addRoute('POST', '/api/v1/ingress/approval-prompts', false);
        addRoute('POST', '/api/v1/ingress/approvals/decision', false);
        addRoute('POST', '^\\/api\\/v1\\/ingress\\/approvals\\/([^/]+)\\/asked$', true);
      }

      // runSelf in app.ts:
      if (src.includes('runSelf')) {
        const runSelfPattern = '^\\/api\\/v1\\/runs\\/([^/]+)\\/(input|result|heartbeat|mailbox|training|reply|agent-config|role-requests|builder)$';
        const branches = expandAlternations(runSelfPattern);
        for (const b of branches) {
          if (b.endsWith('/input$') || b.endsWith('/mailbox$') || b.endsWith('/agent-config$')) {
            addRoute('GET', b, true);
          } else {
            addRoute('POST', b, true);
          }
        }
      }

      function visitIf(node: ts.Node, contextPath?: { pattern: string; isRegex: boolean }, contextMethod?: HttpMethod) {
        if (ts.isIfStatement(node)) {
          const condText = node.expression.getText(sf);

          const guardMatch = condText.match(/(?:path|pathname)\s*!==\s*(?:['"`](\/[^'"`\n]*)['"`]|([A-Z0-9_]+))\s*\|\|\s*req\.method\s*!==\s*['"]([A-Z]+)['"]/);
          if (guardMatch) {
            const p = guardMatch[1] ?? pathConsts.get(guardMatch[2]);
            const m = guardMatch[3] as HttpMethod;
            if (p && m) addRoute(m, p, false);
          }

          const guardOneMatch = condText.match(/!([a-zA-Z0-9_]+)\s*\|\|\s*req\.method\s*!==\s*['"]([A-Z]+)['"]/);
          if (guardOneMatch) {
            const varName = guardOneMatch[1];
            const m = guardOneMatch[2] as HttpMethod;
            const vObj = matchVars.get(varName);
            if (vObj) addRoute(m, vObj.pattern, vObj.isRegex);
          }

          const guardVarMatch = condText.match(/!([a-zA-Z0-9_]+)\s*\|\|\s*\(([^)]*req\.method[^)]*)\)/);
          if (guardVarMatch) {
            const varName = guardVarMatch[1];
            const methodsPart = guardVarMatch[2];
            const mObj = matchVars.get(varName);
            if (mObj) {
              const negMethods = [...methodsPart.matchAll(/req\.method\s*!==\s*['"]([A-Z]+)['"]/g)].map((x) => x[1] as HttpMethod);
              for (const m of negMethods) {
                addRoute(m, mObj.pattern, mObj.isRegex);
              }
            }
          }

          const methods: HttpMethod[] = [];
          for (const m of condText.matchAll(/req\.method\s*===?\s*['"]([A-Z]+)['"]/g)) {
            methods.push(m[1] as HttpMethod);
          }

          if (methods.length > 0) {
            for (const [vName, vObj] of matchVars) {
              if (['runSelf', 'one', 'pkgFiles', 'pkgFile', 'adoptersPath', 'ver'].includes(vName) || (vName === 'm' && vObj.pattern.includes('token'))) continue;
              const re = new RegExp(`\\b${vName}\\b`);
              if (re.test(condText) && !condText.includes(`!${vName}`)) {
                for (const m of methods) {
                  addRoute(m, vObj.pattern, vObj.isRegex);
                }
              }
            }
            for (const [bvName, bvPaths] of boolVars) {
              const re = new RegExp(`\\b${bvName}\\b`);
              if (re.test(condText)) {
                for (const p of bvPaths) {
                  for (const m of methods) {
                    addRoute(m, p, false);
                  }
                }
              }
            }
            const pathMatches = condText.matchAll(/(?:path|pathname)\s*===?\s*(?:['"`](\/[^'"`\n]*)['"`]|([A-Z0-9_]+))/g);
            for (const pm of pathMatches) {
              const p = pm[1] ?? pathConsts.get(pm[2]);
              if (p) {
                for (const m of methods) {
                  addRoute(m, p, false);
                }
              }
            }
          }

          const pathOnlyMatch = condText.match(/^(?:path|pathname)\s*===?\s*['"`](\/[^'"`\n]*)['"`]$/);
          if (pathOnlyMatch) {
            const p = pathOnlyMatch[1];
            ts.forEachChild(node.thenStatement, (child) => visitIf(child, { pattern: p, isRegex: false }, contextMethod));
            return;
          }

          if (contextPath && methods.length > 0) {
            for (const m of methods) {
              addRoute(m, contextPath.pattern, contextPath.isRegex);
            }
          }
        }
        ts.forEachChild(node, (child) => visitIf(child, contextPath, contextMethod));
      }
      visitIf(sf);

      return routes;
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
      const matchesPostUi = extractedPostUi.filter((ext) =>
        CONTROL_PLANE_ROUTES.some((r) => r.method === ext.method && pathToRegex(r.pattern).test(ext.pattern))
      );
      assert.equal(matchesPostUi.length, 0, 'Injected POST /ui must not be covered by CONTROL_PLANE_ROUTES');

      const syntheticSourceRogue = `
        if (path === '/api/v1/rogue-endpoint' && req.method === 'GET') {
          json(res, 200, { rogue: true });
          return;
        }
      `;
      const extractedRogue = extractDispatched(syntheticSourceRogue);
      const matchesRogue = extractedRogue.filter((ext) =>
        CONTROL_PLANE_ROUTES.some((r) => r.method === ext.method && pathToRegex(r.pattern).test(ext.pattern))
      );
      assert.equal(matchesRogue.length, 0, 'Injected GET /api/v1/rogue-endpoint must not be covered by CONTROL_PLANE_ROUTES');

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
      const allDispatched = controlPlane().map((f) => ({
        file: f,
        dispatched: extractDispatched(code(read(f)), f),
      }));

      const unhandled: string[] = [];
      for (const d of allDispatched) {
        for (const ext of d.dispatched) {
          const matches = CONTROL_PLANE_ROUTES.some((r) => {
            if (r.method !== ext.method) return false;
            if (ext.isRegex) {
              return new RegExp(ext.pattern).test(samplePath(r.pattern));
            } else {
              return pathToRegex(r.pattern).test(ext.pattern);
            }
          });
          if (!matches) {
            unhandled.push(`${d.file}: ${ext.method} ${ext.pattern}`);
          }
        }
      }
      assert.deepEqual(unhandled, [], 'Dispatched route in control plane not covered by CONTROL_PLANE_ROUTES');
    });

    it('every row in CONTROL_PLANE_ROUTES corresponds to an actual route in control-plane code (no stale table entries)', () => {
      const allDispatched = controlPlane().flatMap((f) => extractDispatched(code(read(f)), f));

      const staleRoutes: string[] = [];
      for (const r of CONTROL_PLANE_ROUTES) {
        const sp = samplePath(r.pattern);
        const matched = allDispatched.some((ext) => {
          if (ext.method !== r.method) return false;
          if (ext.isRegex) {
            return new RegExp(ext.pattern).test(sp);
          } else {
            return pathToRegex(r.pattern).test(ext.pattern);
          }
        });
        if (!matched) {
          staleRoutes.push(`${r.method} ${r.pattern} (sample: ${sp})`);
        }
      }
      assert.deepEqual(staleRoutes, [], 'Stale route in CONTROL_PLANE_ROUTES not found in control-plane source');
    });

    it('every route declaring privilege corresponds to actual requirePrivilege or authorize enforcement in source', () => {
      const inSource = new Set(controlPlane().flatMap((f) => asked(code(read(f)))));
      const missingEnforcement: string[] = [];
      for (const r of CONTROL_PLANE_ROUTES) {
        if (r.privilege) {
          const privs = Array.isArray(r.privilege) ? r.privilege : [r.privilege];
          for (const p of privs) {
            if (!inSource.has(p)) {
              missingEnforcement.push(`${r.method} ${r.pattern}: privilege '${p}' not asked in control-plane source`);
            }
          }
        }
      }
      assert.deepEqual(missingEnforcement, [], 'Route declares a privilege not enforced in source');
    });
  });
});
