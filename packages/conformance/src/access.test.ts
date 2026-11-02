// DESIGN_AUTHORITY.md §6.12 — operator access. A2: identity is verified, not asserted.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { accessAuthFromEnv, cloudflareAccessAuth } from '@beercanlabs/factory-auth';
import { files, read } from './support.js';

const src = (dir: string) => files(dir, (p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));

describe('A2 identity is verified, not asserted', () => {
  it('no platform code reads an unsigned identity header', () => {
    const offenders = [...src('packages/control-plane/src'), ...src('packages/auth/src'), ...src('packages/gatekeeper/src'), 'packages/console/server.ts']
      .filter((f) => /cf-access-authenticated-user-email/i.test(read(f)));
    assert.deepEqual(offenders, []);
  });

  it('the control plane authenticates only through verifiers (no identity from headers in authenticate)', () => {
    const app = read('packages/control-plane/src/app.ts');
    const fn = app.slice(app.indexOf('export async function identify('), app.indexOf('export async function requirePrivilege('));
    assert.ok(fn.length > 0, 'identify() not found in app.ts');
    assert.match(fn, /state\.auth\.verify\(/);
    assert.match(fn, /state\.access\.verify\(/);
    assert.doesNotMatch(fn, /actor:\s*`/, 'identify() builds a principal itself instead of taking it from a verifier');
  });

  it('the console adds no credential of its own', () => {
    const server = read('packages/console/server.ts');
    assert.doesNotMatch(server, /FACTORY_TOKEN/, 'console server reads FACTORY_TOKEN');
    assert.doesNotMatch(server, /\.authorization\s*=|['"]authorization['"]\s*[:\]]/i, 'console server sets an Authorization header');
    const ecs = read('landing-zones/aws/ecs.tf');
    const consoleTask = ecs.match(/resource "aws_ecs_task_definition" "console" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(consoleTask, 'console task definition not found');
    assert.doesNotMatch(consoleTask, /FACTORY_TOKEN|valueFrom/, 'the console task is given a factory credential');
  });

  it('no admin is built into code; the landing zone leaves Access identity off by default', () => {
    const hardCoded = [...src('packages/auth/src'), ...src('packages/control-plane/src'), 'packages/console/server.ts', ...src('packages/console/src')]
      .filter((f) => /ADMIN_EMAILS[^\n]*(\|\||\?\?)\s*\[?\s*['"][^'"\s]+@/.test(read(f)) || /adminEmails\s*\?\?\s*\[\s*['"]/.test(read(f)));
    assert.deepEqual(hardCoded, []);
    const vars = read('landing-zones/aws/variables.tf');
    for (const v of ['access_team_domain', 'access_aud', 'admin_emails']) {
      const block = vars.match(new RegExp(`variable "${v}" \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
      assert.match(block, /default\s*=\s*""/, `${v} must default to empty (disabled)`);
    }
  });

  it('Access identity fails closed and refuses unsigned and forged assertions', async () => {
    assert.equal(accessAuthFromEnv({}), undefined);
    const team = 'conformance.cloudflareaccess.com';
    const aud = 'conformance-aud';
    const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const bad = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1' };
    const auth = cloudflareAccessAuth({ teamDomain: team, audience: aud, adminEmails: ['admin@example.com'], fetchJwks: async () => ({ keys: [jwk] }) });
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const body = b64({ iss: `https://${team}`, aud: [aud], exp: Math.floor(Date.now() / 1000) + 300, email: 'admin@example.com' });
    const signed = (alg: string, key: typeof good.privateKey) => {
      const input = `${b64({ alg, kid: 'k1' })}.${body}`;
      return `${input}.${rsaSign('sha256', Buffer.from(input), key).toString('base64url')}`;
    };
    assert.equal((await auth.verify(signed('RS256', good.privateKey))).ok, true);
    assert.equal((await auth.verify(signed('RS256', bad.privateKey))).ok, false);
    assert.equal((await auth.verify(`${b64({ alg: 'none', kid: 'k1' })}.${body}.`)).ok, false);
    assert.equal((await auth.verify(signed('HS256', good.privateKey))).ok, false);
  });
});

// ---- S5b / A1 / A2: Cloudflare Access bypass for fk_ API keys on /api/v1 and /mcp ----

type EdgeRequest = {
  host: string;
  path: string;
  headers?: Record<string, string | string[]>;
};

type EdgeOutcome =
  | { action: 'redirect_access_login'; location: string; bypassesInteractiveAccess: false }
  | { action: 'waf_block'; bypassesInteractiveAccess: false }
  | { action: 'access_challenge'; app: string; bypassesInteractiveAccess: false }
  | { action: 'origin'; app: string; bypassesInteractiveAccess: boolean; forwardedHeaders: Record<string, string[]> };

/** Extract a balanced `resource "<type>" "<name>" { ... }` or `variable "<name>" { ... }` block from HCL. */
function hclBlocks(text: string, keyword: 'resource' | 'variable'): Array<{ type?: string; name: string; body: string }> {
  const out: Array<{ type?: string; name: string; body: string }> = [];
  const headerRe =
    keyword === 'resource'
      ? /^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gm
      : /^variable\s+"([^"]+)"\s*\{/gm;
  for (const m of text.matchAll(headerRe)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    let inStr = false;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') i += 2;
        else {
          if (ch === '"') inStr = false;
          i++;
        }
        continue;
      }
      if (ch === '#' || (ch === '/' && text[i + 1] === '/')) {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (ch === '<' && text[i + 1] === '<') {
        const hd = text.slice(i).match(/^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/);
        if (hd) {
          i += hd[0].length;
          const endRe = new RegExp(`^\\s*${hd[1]}\\r?$`, 'm');
          const endMatch = text.slice(i).match(endRe);
          assert.ok(endMatch && endMatch.index !== undefined, `unterminated heredoc ${hd[1]}`);
          i += endMatch.index + endMatch[0].length;
          continue;
        }
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
      }
      i++;
    }
    assert.equal(depth, 0, `unbalanced HCL block for ${m[0]}`);
    out.push(
      keyword === 'resource'
        ? { type: m[1], name: m[2], body: text.slice(start, i - 1) }
        : { name: m[1], body: text.slice(start, i - 1) },
    );
  }
  return out;
}

/** Extract an HCL string attribute `key = "..."` (decoding HCL string escapes). */
function hclStringAttr(text: string, key: string): string {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, 'm');
  const m = text.match(re);
  assert.ok(m, `missing HCL string attribute: ${key}`);
  return JSON.parse(`"${m[1]}"`) as string;
}

/** Minimal recursive-descent evaluator for the Cloudflare Ruleset Engine (Wirefilter) subset used in cloudflare.tf. */
function evalWirefilter(expr: string, req: EdgeRequest): boolean {
  const normHeaders: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    normHeaders[k.toLowerCase()] = Array.isArray(v) ? [...v] : [v];
  }

  type Tok = { kind: 'lparen' | 'rparen' | 'lbrack' | 'rbrack' | 'comma' | 'star' | 'str' | 'num' | 'id'; val: string };
  const tokens: Tok[] = [];
  let p = 0;
  while (p < expr.length) {
    if (/\s/.test(expr[p])) {
      p++;
      continue;
    }
    const ch = expr[p];
    if (ch === '(') { tokens.push({ kind: 'lparen', val: ch }); p++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen', val: ch }); p++; continue; }
    if (ch === '[') { tokens.push({ kind: 'lbrack', val: ch }); p++; continue; }
    if (ch === ']') { tokens.push({ kind: 'rbrack', val: ch }); p++; continue; }
    if (ch === ',') { tokens.push({ kind: 'comma', val: ch }); p++; continue; }
    if (ch === '*') { tokens.push({ kind: 'star', val: ch }); p++; continue; }
    if (ch === '"') {
      let j = p + 1;
      let raw = '';
      while (j < expr.length && expr[j] !== '"') {
        if (expr[j] === '\\') { raw += expr.slice(j, j + 2); j += 2; }
        else { raw += expr[j]; j++; }
      }
      assert.equal(expr[j], '"', `unterminated string in Wirefilter expression: ${expr}`);
      tokens.push({ kind: 'str', val: JSON.parse(`"${raw}"`) as string });
      p = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = p;
      while (j < expr.length && /[0-9]/.test(expr[j])) j++;
      tokens.push({ kind: 'num', val: expr.slice(p, j) });
      p = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = p;
      while (j < expr.length && /[A-Za-z0-9_.]/.test(expr[j])) j++;
      tokens.push({ kind: 'id', val: expr.slice(p, j) });
      p = j;
      continue;
    }
    assert.fail(`unexpected character '${ch}' in Wirefilter expression: ${expr}`);
  }

  let idx = 0;
  const peek = () => tokens[idx];
  const eat = (kind?: Tok['kind'], val?: string): Tok => {
    const t = tokens[idx];
    assert.ok(t, `unexpected end of Wirefilter expression: ${expr}`);
    if (kind) assert.equal(t.kind, kind, `expected ${kind} at token '${t.val}' in: ${expr}`);
    if (val !== undefined) assert.equal(t.val, val, `expected '${val}' at token '${t.val}' in: ${expr}`);
    idx++;
    return t;
  };

  type Val = string | number | boolean | string[] | undefined;

  function parseOr(): boolean {
    let left = parseAnd();
    while (peek()?.kind === 'id' && peek()?.val === 'or') {
      eat('id', 'or');
      const right = parseAnd();
      left = left || right;
    }
    return left;
  }

  function parseAnd(): boolean {
    let left = parseNot();
    while (peek()?.kind === 'id' && peek()?.val === 'and') {
      eat('id', 'and');
      const right = parseNot();
      left = left && right;
    }
    return left;
  }

  function parseNot(): boolean {
    if (peek()?.kind === 'id' && peek()?.val === 'not') {
      eat('id', 'not');
      return !parseNot();
    }
    return parseAtomBool();
  }

  function parseAtomBool(): boolean {
    if (peek()?.kind === 'lparen') {
      eat('lparen');
      const v = parseOr();
      eat('rparen');
      return v;
    }
    if (peek()?.kind === 'id' && peek()?.val === 'any') {
      eat('id', 'any');
      eat('lparen');
      const arr = parseValue();
      eat('id', 'contains');
      const needle = String(parseValue() ?? '');
      eat('rparen');
      return Array.isArray(arr) && arr.some((item) => item.includes(needle));
    }
    const left = parseValue();
    const next = peek();
    if (next?.kind === 'id' && ['eq', 'ne', 'gt', 'contains'].includes(next.val)) {
      const op = eat('id').val;
      const right = parseValue();
      if (op === 'eq') return left === right;
      if (op === 'ne') return left !== right;
      if (op === 'gt') return typeof left === 'number' && typeof right === 'number' && left > right;
      if (op === 'contains') return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    }
    assert.equal(typeof left, 'boolean', `expected boolean expression, got ${String(left)} in: ${expr}`);
    return Boolean(left);
  }

  function parseValue(): Val {
    const t = peek();
    assert.ok(t, `expected value in Wirefilter expression: ${expr}`);
    if (t.kind === 'str') return eat('str').val;
    if (t.kind === 'num') return Number(eat('num').val);
    if (t.kind === 'id') {
      const name = eat('id').val;
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (name === 'http.host') return req.host;
      if (name === 'http.request.uri.path') return req.path;
      if (name === 'http.request.headers') {
        eat('lbrack');
        const hName = eat('str').val.toLowerCase();
        eat('rbrack');
        const list = normHeaders[hName] ?? [];
        if (peek()?.kind === 'lbrack') {
          eat('lbrack');
          if (peek()?.kind === 'star') {
            eat('star');
            eat('rbrack');
            return list;
          }
          const n = Number(eat('num').val);
          eat('rbrack');
          return list[n];
        }
        return list;
      }
      if (peek()?.kind === 'lparen') {
        eat('lparen');
        const args: Val[] = [];
        if (peek()?.kind !== 'rparen') {
          args.push(parseValue());
          while (peek()?.kind === 'comma') {
            eat('comma');
            args.push(parseValue());
          }
        }
        eat('rparen');
        if (name === 'lower') return typeof args[0] === 'string' ? args[0].toLowerCase() : undefined;
        if (name === 'len') {
          if (args[0] === undefined) return 0;
          if (typeof args[0] === 'string' || Array.isArray(args[0])) return args[0].length;
          assert.fail(`len() unsupported arg in: ${expr}`);
        }
        if (name === 'starts_with') {
          return typeof args[0] === 'string' && typeof args[1] === 'string' && args[0].startsWith(args[1]);
        }
        if (name === 'substring') {
          if (typeof args[0] !== 'string' || typeof args[1] !== 'number') return undefined;
          return args[2] !== undefined ? args[0].slice(args[1], Number(args[2])) : args[0].slice(args[1]);
        }
        if (name === 'trim') {
          return typeof args[0] === 'string' ? args[0].trim() : undefined;
        }
        assert.fail(`unsupported Wirefilter function '${name}' in: ${expr}`);
      }
    }
    assert.fail(`unexpected token '${t.val}' in Wirefilter expression: ${expr}`);
  }

  const out = parseOr();
  assert.equal(idx, tokens.length, `trailing tokens starting at '${tokens[idx]?.val}' in: ${expr}`);
  return out;
}

/** Match a Cloudflare Access destination pattern (`<host><pathPattern>`, with optional trailing `/*`). */
function matchesAccessDestination(destUri: string, host: string, path: string): { matched: boolean; specificity: number } {
  const slash = destUri.indexOf('/');
  const destHost = (slash >= 0 ? destUri.slice(0, slash) : destUri).toLowerCase();
  const destPath = slash >= 0 ? destUri.slice(slash) : '/*';
  if (host.toLowerCase() !== destHost) return { matched: false, specificity: -1 };
  if (destPath === '/*') return { matched: true, specificity: 1 };
  if (destPath.endsWith('/*')) {
    const prefix = destPath.slice(0, -1).toLowerCase(); // keeps trailing '/'
    if (path.toLowerCase().startsWith(prefix)) return { matched: true, specificity: prefix.length + 10 };
    return { matched: false, specificity: -1 };
  }
  if (path.toLowerCase() === destPath.toLowerCase()) return { matched: true, specificity: destPath.length + 100 };
  return { matched: false, specificity: -1 };
}

/** Build a live edge simulator directly from the Terraform configuration in `landing-zones/aws/cloudflare.tf`. */
function loadCloudflareEdgeConfig(host = 'factory.example.com', webhookPaths = ['/api/v1/hooks/*']) {
  const tf = read('landing-zones/aws/cloudflare.tf');
  const rawApiBypassList = tf.match(/cloudflare_api_key_bypass_paths\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const apiKeyBypassPaths = [...rawApiBypassList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(apiKeyBypassPaths.length > 0, 'cloudflare_api_key_bypass_paths not found in cloudflare.tf');

  const webhookClauses = webhookPaths.map((p) =>
    p.endsWith('/*')
      ? `starts_with(lower(http.request.uri.path), "${p.slice(0, -1).toLowerCase()}")`
      : `lower(http.request.uri.path) eq "${p.toLowerCase()}"`,
  );
  const webhookPathExpr = webhookClauses.length > 0 ? `(${webhookClauses.join(' or ')})` : 'false';

  const interpolate = (raw: string): string =>
    raw
      .replaceAll('${local.cloudflare_host}', host)
      .replaceAll('${local.cloudflare_webhook_path_expr}', webhookPathExpr);

  const guardScopeExpr = interpolate(hclStringAttr(tf, 'cloudflare_fk_guard_scope_expr'));
  const canonicalPathExpr = interpolate(hclStringAttr(tf, 'cloudflare_fk_canonical_path_expr'));
  const fkBearerExpr = interpolate(hclStringAttr(tf, 'cloudflare_fk_bearer_expr'));
  const fkValidRequestExpr = hclStringAttr(tf, 'cloudflare_fk_valid_request_expr')
    .replaceAll('${local.cloudflare_fk_canonical_path_expr}', canonicalPathExpr)
    .replaceAll('${local.cloudflare_fk_bearer_expr}', fkBearerExpr);
  const accessCookieExpr = interpolate(hclStringAttr(tf, 'cloudflare_access_cookie_expr'));

  const resources = hclBlocks(tf, 'resource');
  const ruleset = (name: string) => {
    const r = resources.find((b) => b.type === 'cloudflare_ruleset' && b.name === name);
    assert.ok(r, `missing cloudflare_ruleset.${name}`);
    return r.body;
  };

  const resolveRulesetExpr = (raw: string): string =>
    interpolate(raw)
      .replaceAll('${local.cloudflare_fk_guard_scope_expr}', guardScopeExpr)
      .replaceAll('${local.cloudflare_fk_valid_request_expr}', fkValidRequestExpr)
      .replaceAll('${local.cloudflare_access_cookie_expr}', accessCookieExpr);

  const redirectBody = ruleset('api_keys_unauthenticated_redirect');
  const redirectExpr = resolveRulesetExpr(hclStringAttr(redirectBody, 'expression'));
  const redirectTarget = interpolate(hclStringAttr(redirectBody, 'value'));

  const wafBody = ruleset('api_keys_bypass_guard');
  const wafExpr = resolveRulesetExpr(hclStringAttr(wafBody, 'expression'));

  const apps: Array<{ name: string; decision: 'allow' | 'bypass'; destinations: string[] }> = [
    { name: 'factory', decision: 'allow', destinations: [`${host}/*`] },
    { name: 'webhooks_bypass', decision: 'bypass', destinations: webhookPaths.map((p) => `${host}${p}`) },
    { name: 'api_keys_bypass', decision: 'bypass', destinations: apiKeyBypassPaths.map((p) => `${host}${p}`) },
  ];

  function evaluate(req: EdgeRequest): EdgeOutcome {
    const hasInteractiveSession = Object.entries(req.headers ?? {}).some(
      ([k, v]) => k.toLowerCase() === 'cookie' && (Array.isArray(v) ? v : [v]).some((c) => c.includes('CF_Authorization=eyJ')),
    );

    // Phase 1: Single Redirects (`http_request_dynamic_redirect`)
    if (evalWirefilter(redirectExpr, req)) {
      return { action: 'redirect_access_login', location: redirectTarget, bypassesInteractiveAccess: false };
    }

    // Phase 8: WAF Custom Rules (`http_request_firewall_custom`)
    if (evalWirefilter(wafExpr, req)) {
      return { action: 'waf_block', bypassesInteractiveAccess: false };
    }

    // Phase 11: Cloudflare Access application check (most-specific destination wins)
    let winner: { name: string; decision: 'allow' | 'bypass'; specificity: number } | undefined;
    for (const app of apps) {
      for (const dest of app.destinations) {
        const m = matchesAccessDestination(dest, req.host, req.path);
        if (m.matched && (!winner || m.specificity > winner.specificity)) {
          winner = { name: app.name, decision: app.decision, specificity: m.specificity };
        }
      }
    }
    assert.ok(winner, `no Cloudflare Access application matched ${req.host}${req.path}`);

    if (winner.decision === 'allow' && !hasInteractiveSession) {
      return { action: 'access_challenge', app: winner.name, bypassesInteractiveAccess: false };
    }

    // Phase 14: Request Header Transform (`http_request_late_transform`)
    const forwardedHeaders: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      forwardedHeaders[k.toLowerCase()] = Array.isArray(v) ? [...v] : [v];
    }
    if (evalWirefilter(guardScopeExpr, req)) {
      delete forwardedHeaders['cf-access-jwt-assertion'];
      delete forwardedHeaders['cf-access-authenticated-user-email'];
    }

    return {
      action: 'origin',
      app: winner.name,
      bypassesInteractiveAccess: !hasInteractiveSession,
      forwardedHeaders,
    };
  }

  return { apiKeyBypassPaths, evaluate };
}

describe('A1 / A2 / S5b Cloudflare Access bypass is restricted to fk_ API keys on /api/v1 and /mcp (and webhooks)', () => {
  it('declares Cloudflare provider and leaves edge resources disabled by default without plaintext secrets', () => {
    const mainTf = read('landing-zones/aws/main.tf');
    assert.match(mainTf, /cloudflare\s*=\s*\{\s*source\s*=\s*"cloudflare\/cloudflare"/);

    const cfTf = read('landing-zones/aws/cloudflare.tf');
    assert.match(cfTf, /provider\s+"cloudflare"\s*\{\s*\}/, 'cloudflare provider block must take credentials from env, not variables');
    assert.doesNotMatch(cfTf, /api_token\s*=|api_key\s*=/, 'cloudflare.tf must never set credential values in HCL');

    const varsTf = read('landing-zones/aws/variables.tf');
    const zoneVar = hclBlocks(varsTf, 'variable').find((v) => v.name === 'cloudflare_zone_id');
    assert.ok(zoneVar, 'variable cloudflare_zone_id must be declared');
    assert.match(zoneVar.body, /default\s*=\s*""/, 'cloudflare_zone_id must default to empty string');
  });

  it('no Access application or policy in the landing zone bypasses any path outside /api/v1, /mcp, and webhooks', () => {
    const allTf = files('landing-zones/aws', (p) => p.endsWith('.tf'));
    const accessResources = allTf.flatMap((f) =>
      hclBlocks(read(f), 'resource')
        .filter((b) => b.type?.startsWith('cloudflare_zero_trust_access_'))
        .map((b) => ({ file: f, ...b })),
    );
    assert.ok(accessResources.length >= 3, 'expected root, webhooks_bypass, and api_keys_bypass Access applications');

    const root = accessResources.find((r) => r.type === 'cloudflare_zero_trust_access_application' && r.name === 'factory');
    assert.ok(root, 'missing root cloudflare_zero_trust_access_application.factory');
    assert.match(root.body, /uri\s*=\s*"\$\{local\.cloudflare_host\}\/\*"/);
    assert.match(root.body, /decision\s*=\s*"allow"/);
    assert.doesNotMatch(root.body, /decision\s*=\s*"bypass"/, 'root Access application must never use bypass');
    assert.doesNotMatch(root.body, /\beveryone\s*=/, 'root Access application must never include everyone');

    const bypassing = accessResources.filter((r) => /decision\s*=\s*"bypass"/.test(r.body));
    assert.deepEqual(
      bypassing.map((r) => `${r.type}.${r.name}`).sort(),
      [
        'cloudflare_zero_trust_access_application.api_keys_bypass',
        'cloudflare_zero_trust_access_application.webhooks_bypass',
      ],
      'only api_keys_bypass and webhooks_bypass may declare decision = "bypass"',
    );

    const { apiKeyBypassPaths } = loadCloudflareEdgeConfig();
    assert.deepEqual(
      apiKeyBypassPaths,
      ['/api/v1', '/api/v1/*', '/mcp'],
      'api_keys_bypass paths must be strictly /api/v1, /api/v1/*, and /mcp',
    );

    const varsTf = read('landing-zones/aws/variables.tf');
    const webhookVar = hclBlocks(varsTf, 'variable').find((v) => v.name === 'cloudflare_webhook_paths');
    assert.ok(webhookVar, 'variable cloudflare_webhook_paths must be declared');
    assert.match(webhookVar.body, /default\s*=\s*\["\/api\/v1\/hooks\/\*"\]/);
    const regexMatch = webhookVar.body.match(/regex\("((?:\\.|[^"\\])*)"\s*,\s*p\)/);
    assert.ok(regexMatch, 'cloudflare_webhook_paths must validate each path with regex(..., p)');
    const webhookPattern = new RegExp(JSON.parse(`"${regexMatch[1]}"`) as string);
    const validWebhook = (p: string) => webhookPattern.test(p) && !p.includes('..');

    for (const allowed of ['/api/v1/hooks/*', '/api/v1/hooks/github', '/hooks/*', '/hooks/github']) {
      assert.equal(validWebhook(allowed), true, `expected webhook path ${allowed} to pass validation`);
    }
    for (const forbidden of ['/*', '/', '/api/v1', '/api/v1/*', '/mcp', '/mcp/*', '/ui', '/healthz', '/api/v1/hooks/../agents']) {
      assert.equal(validWebhook(forbidden), false, `expected non-webhook path ${forbidden} to fail validation`);
    }
  });

  it('pairs api_keys_bypass with pre-Access login redirect, pre-Access WAF block, and post-Access header sanitization', () => {
    const cfTf = read('landing-zones/aws/cloudflare.tf');
    const rulesets = hclBlocks(cfTf, 'resource').filter((b) => b.type === 'cloudflare_ruleset');
    assert.deepEqual(
      rulesets.map((r) => r.name).sort(),
      ['api_keys_bypass_guard', 'api_keys_header_sanitize', 'api_keys_unauthenticated_redirect'],
    );

    const redirect = rulesets.find((r) => r.name === 'api_keys_unauthenticated_redirect')!;
    assert.equal(hclStringAttr(redirect.body, 'phase'), 'http_request_dynamic_redirect');
    assert.equal(hclStringAttr(redirect.body, 'action'), 'redirect');
    assert.match(redirect.body, /\/cdn-cgi\/access\/login"/);

    const guard = rulesets.find((r) => r.name === 'api_keys_bypass_guard')!;
    assert.equal(hclStringAttr(guard.body, 'phase'), 'http_request_firewall_custom');
    assert.equal(hclStringAttr(guard.body, 'action'), 'block');

    const sanitize = rulesets.find((r) => r.name === 'api_keys_header_sanitize')!;
    assert.equal(hclStringAttr(sanitize.body, 'phase'), 'http_request_late_transform');
    assert.equal(hclStringAttr(sanitize.body, 'action'), 'rewrite');
    assert.match(sanitize.body, /"cf-access-jwt-assertion"\s*=\s*\{\s*operation\s*=\s*"remove"\s*\}/);
    assert.match(sanitize.body, /"cf-access-authenticated-user-email"\s*=\s*\{\s*operation\s*=\s*"remove"\s*\}/);
  });

  it('evaluates bypass rules: only /api/v1, /api/v1/*, and /mcp with Bearer fk_ keys (plus webhooks) bypass interactive Access', () => {
    const host = 'factory.example.com';
    const { evaluate } = loadCloudflareEdgeConfig(host);

    // 1. Positive cases: valid `Bearer fk_<token>` on `/api/v1`, `/api/v1/*`, and `/mcp` reaches origin without interactive Access or CF-Access-Client-Id.
    for (const path of ['/api/v1', '/api/v1/whoami', '/api/v1/agents/higgins', '/api/v1/health', '/mcp']) {
      const res = evaluate({
        host,
        path,
        headers: {
          authorization: 'Bearer fk_example_key_1',
          'cf-access-jwt-assertion': 'forged.jwt.value',
          'cf-access-authenticated-user-email': 'spoof@example.com',
        },
      });
      assert.equal(res.action, 'origin', `expected fk_ key on ${path} to reach origin`);
      assert.equal(res.bypassesInteractiveAccess, true, `expected fk_ key on ${path} to bypass interactive Access`);
      assert.equal(res.forwardedHeaders['cf-access-jwt-assertion'], undefined, 'spoofed cf-access-jwt-assertion must be stripped');
      assert.equal(res.forwardedHeaders['cf-access-authenticated-user-email'], undefined, 'spoofed email header must be stripped');
      assert.deepEqual(res.forwardedHeaders['authorization'], ['Bearer fk_example_key_1']);
    }

    // 2. Signature-verified webhook paths retain their Access bypass without an fk_ key (D22, A1).
    for (const path of ['/api/v1/hooks/github', '/api/v1/hooks/switch']) {
      const res = evaluate({ host, path, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } });
      assert.equal(res.action, 'origin', `expected webhook path ${path} to reach origin`);
      assert.equal(res.app, 'webhooks_bypass');
      assert.equal(res.bypassesInteractiveAccess, true);
    }

    // 3. Keyless unauthenticated requests on `/api/v1*` and `/mcp` hit the Cloudflare Access login redirect (S5b).
    for (const path of ['/api/v1', '/api/v1/whoami', '/api/v1/agents', '/api/v1/health', '/mcp', '/mcp/tools']) {
      const res = evaluate({ host, path });
      assert.equal(res.action, 'redirect_access_login', `expected keyless request on ${path} to redirect to Access login`);
      assert.equal(res.location, `https://${host}/cdn-cgi/access/login`);
      assert.equal(res.bypassesInteractiveAccess, false);
    }

    // 4. Non-fk_ credentials, malformed fk_ headers, duplicate Authorization headers, and case/subpath tricks are blocked at WAF.
    const badAuthCases: Array<{ label: string; path: string; headers: Record<string, string | string[]> }> = [
      { label: 'legacy non-fk bearer', path: '/api/v1/whoami', headers: { authorization: 'Bearer legacy_shared_token' } },
      { label: 'OIDC JWT bearer without fk_', path: '/mcp', headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig' } },
      { label: 'empty fk_ suffix', path: '/api/v1/whoami', headers: { authorization: 'Bearer fk_' } },
      { label: 'whitespace-only fk_ suffix', path: '/api/v1/whoami', headers: { authorization: 'Bearer fk_   ' } },
      { label: 'internal space after fk_ token', path: '/mcp', headers: { authorization: 'Bearer fk_abc extra' } },
      { label: 'lowercase bearer scheme', path: '/api/v1/agents', headers: { authorization: 'bearer fk_example_key_1' } },
      { label: 'Basic auth scheme', path: '/api/v1/agents', headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { label: 'bare fk_ without Bearer prefix', path: '/mcp', headers: { authorization: 'fk_example_key_1' } },
      { label: 'duplicate Authorization header smuggling', path: '/api/v1/whoami', headers: { authorization: ['Bearer fk_example_key_1', 'Bearer other'] } },
      { label: 'shared CF-Access-Client-Id without fk_ key', path: '/api/v1/whoami', headers: { 'cf-access-client-id': 'id', 'cf-access-client-secret': 'sec', authorization: 'Bearer old_tok' } },
      { label: 'subpath under /mcp', path: '/mcp/subpath', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'uppercase /API/V1 path', path: '/API/V1/whoami', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'uppercase /MCP path', path: '/MCP', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'forged non-JWT cookie on /api/v1/whoami', path: '/api/v1/whoami', headers: { cookie: 'CF_Authorization=not-a-jwt' } },
      { label: 'cookie without fk_ key on /api/v1/health', path: '/api/v1/health', headers: { cookie: 'CF_Authorization=eyJhbGciOiJSUzI1NiJ9.e30.sig' } },
      { label: 'cookie without fk_ key on /mcp', path: '/mcp', headers: { cookie: 'CF_Authorization=eyJhbGciOiJSUzI1NiJ9.e30.sig' } },
    ];
    for (const c of badAuthCases) {
      const res = evaluate({ host, path: c.path, headers: c.headers });
      assert.notEqual(res.action, 'origin', `expected '${c.label}' on ${c.path} NOT to reach origin`);
      assert.equal(res.bypassesInteractiveAccess, false, `expected '${c.label}' NOT to bypass interactive Access`);
    }

    // 5. All other paths remain gated by the root Cloudflare Access application even when carrying a valid `Bearer fk_...` key!
    for (const path of ['/', '/ui', '/ui/assets/app.js', '/healthz', '/metrics', '/.well-known/factory-cli', '/api/v2/agents', '/apiv1', '/mcp-other']) {
      for (const headers of [{}, { authorization: 'Bearer fk_example_key_1' }]) {
        const res = evaluate({ host, path, headers });
        assert.equal(res.action, 'access_challenge', `expected ${path} (${Object.keys(headers).length ? 'with fk_' : 'anonymous'}) to hit root Access challenge`);
        assert.equal(res.app, 'factory');
        assert.equal(res.bypassesInteractiveAccess, false);
      }
    }

    // 6. Interactive Access browser session cookie (post-challenge) passes on `/api/v1/whoami` without bypassing interactive Access, while stripping spoofed headers.
    const interactiveSession = evaluate({
      host,
      path: '/api/v1/whoami',
      headers: {
        cookie: 'CF_Authorization=eyJhbGciOiJSUzI1NiJ9.e30.sig',
        'cf-access-jwt-assertion': 'forged.jwt.value',
      },
    });
    assert.equal(interactiveSession.action, 'origin');
    assert.equal(interactiveSession.bypassesInteractiveAccess, false);
    assert.equal(interactiveSession.forwardedHeaders['cf-access-jwt-assertion'], undefined);

    // 7. Negative sanity checks on destination matcher so evaluator itself cannot be vacuous.
    assert.equal(matchesAccessDestination(`${host}/*`, host, '/ui').matched, true);
    assert.equal(matchesAccessDestination(`${host}/mcp`, host, '/mcp/tools').matched, false);
    assert.equal(matchesAccessDestination(`other.example.com/api/v1/*`, host, '/api/v1/whoami').matched, false);
  });
});
