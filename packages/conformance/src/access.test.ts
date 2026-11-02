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
  method?: string;
  host: string;
  path: string;
  query?: string;
  headers?: Record<string, string | string[]>;
  /** Cryptographically verified Cloudflare Access interactive session (never inferred from raw Cookie headers). */
  authenticatedAccessSession?: boolean;
  /** Cryptographically verified Cloudflare Access service token ID (matched only when configured on the Access policy). */
  serviceTokenId?: string;
};

type EdgeOutcome =
  | { action: 'waf_block'; bypassesInteractiveAccess: false }
  | { action: 'worker_block'; status: number; bypassesInteractiveAccess: true }
  | { action: 'access_challenge'; app: string; preservedPathAndQuery: string; bypassesInteractiveAccess: false }
  | {
      action: 'origin';
      app: string;
      decision: 'allow' | 'non_identity' | 'bypass';
      bypassesInteractiveAccess: boolean;
      originPath: string;
      originQuery: string;
      forwardedHeaders: Record<string, string[]>;
    };

/** Extract balanced top-level `resource`, `data`, `variable`, or `output` blocks from HCL. */
function hclBlocks(
  text: string,
  keyword: 'resource' | 'data' | 'variable' | 'output',
): Array<{ type?: string; name: string; body: string }> {
  const out: Array<{ type?: string; name: string; body: string }> = [];
  const headerRe =
    keyword === 'resource' || keyword === 'data'
      ? new RegExp(`^${keyword}\\s+"([^"]+)"\\s+"([^"]+)"\\s*\\{`, 'gm')
      : new RegExp(`^${keyword}\\s+"([^"]+)"\\s*\\{`, 'gm');
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
      keyword === 'resource' || keyword === 'data'
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

/** Evaluate a Cloudflare Ruleset Engine (Wirefilter) boolean or string expression used in cloudflare.tf. */
function evalWirefilterValue(expr: string, req: { host: string; path: string; headers?: Record<string, string | string[]> }) {
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

  function parseOr(): Val {
    let left = parseAnd();
    while (peek()?.kind === 'id' && peek()?.val === 'or') {
      eat('id', 'or');
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  function parseAnd(): Val {
    let left = parseNot();
    while (peek()?.kind === 'id' && peek()?.val === 'and') {
      eat('id', 'and');
      const right = parseNot();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  function parseNot(): Val {
    if (peek()?.kind === 'id' && peek()?.val === 'not') {
      eat('id', 'not');
      return !Boolean(parseNot());
    }
    return parseAtom();
  }

  function parseAtom(): Val {
    if (peek()?.kind === 'lparen') {
      eat('lparen');
      const v = parseOr();
      eat('rparen');
      return v;
    }
    if (peek()?.kind === 'id' && peek()?.val === 'any') {
      eat('id', 'any');
      eat('lparen');
      const arr = parsePrimaryValue();
      eat('id', 'contains');
      const needle = String(parsePrimaryValue() ?? '');
      eat('rparen');
      return Array.isArray(arr) && arr.some((item) => item.includes(needle));
    }
    const left = parsePrimaryValue();
    const next = peek();
    if (next?.kind === 'id' && ['eq', 'ne', 'gt', 'contains'].includes(next.val)) {
      const op = eat('id').val;
      const right = parsePrimaryValue();
      if (op === 'eq') return left === right;
      if (op === 'ne') return left !== right;
      if (op === 'gt') return typeof left === 'number' && typeof right === 'number' && left > right;
      if (op === 'contains') return typeof left === 'string' && typeof right === 'string' && left.includes(right);
    }
    return left;
  }

  function parsePrimaryValue(): Val {
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
          args.push(parseOr());
          while (peek()?.kind === 'comma') {
            eat('comma');
            args.push(parseOr());
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
        if (name === 'concat') {
          return args.map((a) => String(a ?? '')).join('');
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

function evalWirefilter(expr: string, req: { host: string; path: string; headers?: Record<string, string | string[]> }): boolean {
  const v = evalWirefilterValue(expr, req);
  assert.equal(typeof v, 'boolean', `expected boolean expression, got ${String(v)} in: ${expr}`);
  return v;
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

/** Match a Cloudflare Workers route pattern (`<host>/<prefix>*`). */
function matchesWorkerRoute(pattern: string, host: string, path: string): boolean {
  const slash = pattern.indexOf('/');
  const routeHost = (slash >= 0 ? pattern.slice(0, slash) : pattern).toLowerCase();
  const routePath = slash >= 0 ? pattern.slice(slash) : '/*';
  if (host.toLowerCase() !== routeHost) return false;
  if (routePath.endsWith('*')) {
    return path.startsWith(routePath.slice(0, -1));
  }
  return path === routePath;
}

/** Build a live edge simulator directly from the Terraform configuration in `landing-zones/aws/cloudflare.tf`. */
async function loadCloudflareEdgeConfig(
  host = 'factory.example.com',
  webhookPaths = ['/api/v1/hooks/*'],
  opts: { serviceTokenIds?: string[] } = {},
) {
  const tf = read('landing-zones/aws/cloudflare.tf');
  const rawApiBypassList = tf.match(/cloudflare_api_key_bypass_paths\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const apiKeyBypassPaths = [...rawApiBypassList.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(apiKeyBypassPaths.length > 0, 'cloudflare_api_key_bypass_paths not found in cloudflare.tf');

  const bypassPrefix = hclStringAttr(tf, 'cloudflare_fk_bypass_prefix');

  const webhookClauses = webhookPaths.map((p) =>
    p.endsWith('/*')
      ? `starts_with(lower(http.request.uri.path), "${p.slice(0, -1).toLowerCase()}")`
      : `lower(http.request.uri.path) eq "${p.toLowerCase()}"`,
  );
  const webhookPathExpr = webhookClauses.length > 0 ? `(${webhookClauses.join(' or ')})` : 'false';

  const rewrittenWebhookClauses = webhookPaths.map((p) =>
    p.endsWith('/*')
      ? `starts_with(lower(http.request.uri.path), "${bypassPrefix}${p.slice(0, -1).toLowerCase()}")`
      : `lower(http.request.uri.path) eq "${bypassPrefix}${p.toLowerCase()}"`,
  );
  const rewrittenWebhookPathExpr = rewrittenWebhookClauses.length > 0 ? `(${rewrittenWebhookClauses.join(' or ')})` : 'false';

  const noTraversalExpr = hclStringAttr(tf, 'cloudflare_no_traversal_expr');
  const canonicalPathExpr = hclStringAttr(tf, 'cloudflare_fk_canonical_path_expr').replaceAll(
    '${local.cloudflare_no_traversal_expr}',
    noTraversalExpr,
  );
  const fkBearerExpr = hclStringAttr(tf, 'cloudflare_fk_bearer_expr');

  const interpolate = (raw: string): string =>
    raw
      .replaceAll('${local.cloudflare_host}', host)
      .replaceAll('${local.cloudflare_fk_bypass_prefix}', bypassPrefix)
      .replaceAll('${local.cloudflare_webhook_path_expr}', webhookPathExpr)
      .replaceAll('${local.cloudflare_rewritten_webhook_path_expr}', rewrittenWebhookPathExpr)
      .replaceAll('${local.cloudflare_no_traversal_expr}', noTraversalExpr)
      .replaceAll('${local.cloudflare_fk_canonical_path_expr}', canonicalPathExpr)
      .replaceAll('${local.cloudflare_fk_bearer_expr}', fkBearerExpr);

  const fkRewriteExpr = interpolate(hclStringAttr(tf, 'cloudflare_fk_rewrite_expr'));
  const fkPrefixScopeExpr = interpolate(hclStringAttr(tf, 'cloudflare_fk_bypass_prefix_scope_expr'));
  const fkRewrittenValidExpr = interpolate(hclStringAttr(tf, 'cloudflare_fk_rewritten_valid_expr'));
  const headerSanitizeScopeExpr = interpolate(hclStringAttr(tf, 'cloudflare_header_sanitize_scope_expr'));

  const resolveExpr = (raw: string): string =>
    interpolate(raw)
      .replaceAll('${local.cloudflare_fk_rewrite_expr}', fkRewriteExpr)
      .replaceAll('${local.cloudflare_fk_bypass_prefix_scope_expr}', fkPrefixScopeExpr)
      .replaceAll('${local.cloudflare_fk_rewritten_valid_expr}', fkRewrittenValidExpr)
      .replaceAll('${local.cloudflare_header_sanitize_scope_expr}', headerSanitizeScopeExpr);

  const resources = hclBlocks(tf, 'resource');
  const ruleset = (name: string) => {
    const r = resources.find((b) => b.type === 'cloudflare_ruleset' && b.name === name);
    assert.ok(r, `missing cloudflare_ruleset.${name}`);
    return r.body;
  };

  const rewriteBody = ruleset('api_keys_bypass_rewrite');
  const rewriteRuleExpr = resolveExpr(
    rewriteBody.match(/expression\s*=\s*(local\.[a-z0-9_]+|"(?:\\.|[^"\\])*")/)?.[1]?.startsWith('local.')
      ? fkRewriteExpr
      : hclStringAttr(rewriteBody, 'expression'),
  );
  const rewritePathExprMatch = rewriteBody.match(/path\s*=\s*\{\s*expression\s*=\s*"((?:\\.|[^"\\])*)"/);
  assert.ok(rewritePathExprMatch, 'missing action_parameters.uri.path.expression in api_keys_bypass_rewrite');
  const rewritePathValueExpr = resolveExpr(JSON.parse(`"${rewritePathExprMatch[1]}"`) as string);

  const wafBody = ruleset('api_keys_bypass_guard');
  const wafExpr = resolveExpr(hclStringAttr(wafBody, 'expression'));

  const apiKeysBypassResource = resources.find(
    (b) => b.type === 'cloudflare_zero_trust_access_application' && b.name === 'api_keys_bypass',
  );
  assert.ok(apiKeysBypassResource, 'missing cloudflare_zero_trust_access_application.api_keys_bypass');
  const apiKeysBypassDestUri = resolveExpr(hclStringAttr(apiKeysBypassResource.body, 'uri'));

  const workerRouteResource = resources.find((b) => b.type === 'cloudflare_workers_route' && b.name === 'api_keys_bypass_strip');
  assert.ok(workerRouteResource, 'missing cloudflare_workers_route.api_keys_bypass_strip');
  const workerRoutePattern = resolveExpr(hclStringAttr(workerRouteResource.body, 'pattern'));

  const workerJsMatch = tf.match(/cloudflare_fk_strip_worker_js\s*=\s*<<-?EOT\r?\n([\s\S]*?)\r?\n\s*EOT/);
  assert.ok(workerJsMatch, 'missing cloudflare_fk_strip_worker_js heredoc in cloudflare.tf');
  const workerModule = (await import(
    `data:text/javascript;base64,${Buffer.from(workerJsMatch[1]).toString('base64')}`
  )) as { default: { fetch(req: Request): Promise<Response> } };

  const apps: Array<{ name: string; kind: 'root' | 'bypass'; destinations: string[] }> = [
    { name: 'factory', kind: 'root', destinations: [`${host}/*`] },
    { name: 'webhooks_bypass', kind: 'bypass', destinations: webhookPaths.map((p) => `${host}${p}`) },
    { name: 'api_keys_bypass', kind: 'bypass', destinations: [apiKeysBypassDestUri] },
  ];

  const configuredServiceTokens = new Set((opts.serviceTokenIds ?? []).map((s) => s.trim()).filter(Boolean));

  async function evaluate(req: EdgeRequest): Promise<EdgeOutcome> {
    let currentPath = req.path;
    const querySuffix = req.query ? (req.query.startsWith('?') ? req.query : `?${req.query}`) : '';

    // Phase 3: URL Rewrite (`http_request_transform`, after `http_request_sanitize`)
    if (evalWirefilter(rewriteRuleExpr, { host: req.host, path: currentPath, headers: req.headers })) {
      const nextPath = evalWirefilterValue(rewritePathValueExpr, { host: req.host, path: currentPath, headers: req.headers });
      assert.equal(typeof nextPath, 'string');
      currentPath = nextPath as string;
    }

    // Phase 8: WAF Custom Rules (`http_request_firewall_custom`)
    if (evalWirefilter(wafExpr, { host: req.host, path: currentPath, headers: req.headers })) {
      return { action: 'waf_block', bypassesInteractiveAccess: false };
    }

    // Phase 11: Cloudflare Access application check (most-specific destination wins)
    let winner: { name: string; kind: 'root' | 'bypass'; specificity: number } | undefined;
    for (const app of apps) {
      for (const dest of app.destinations) {
        const m = matchesAccessDestination(dest, req.host, currentPath);
        if (m.matched && (!winner || m.specificity > winner.specificity)) {
          winner = { name: app.name, kind: app.kind, specificity: m.specificity };
        }
      }
    }
    assert.ok(winner, `no Cloudflare Access application matched ${req.host}${currentPath}`);

    let effectiveDecision: 'allow' | 'non_identity' | 'bypass';
    if (winner.kind === 'bypass') {
      effectiveDecision = 'bypass';
    } else if (req.authenticatedAccessSession === true) {
      effectiveDecision = 'allow';
    } else if (req.serviceTokenId && configuredServiceTokens.has(req.serviceTokenId)) {
      effectiveDecision = 'non_identity';
    } else {
      return {
        action: 'access_challenge',
        app: winner.name,
        preservedPathAndQuery: `${currentPath}${querySuffix}`,
        bypassesInteractiveAccess: false,
      };
    }

    const bypassesInteractiveAccess = effectiveDecision === 'bypass';

    // Phase 14: Request Header Transform (`http_request_late_transform`)
    const forwardedHeaders: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      forwardedHeaders[k.toLowerCase()] = Array.isArray(v) ? [...v] : [v];
    }
    if (evalWirefilter(headerSanitizeScopeExpr, { host: req.host, path: currentPath, headers: req.headers })) {
      delete forwardedHeaders['cf-access-jwt-assertion'];
      delete forwardedHeaders['cf-access-authenticated-user-email'];
    }

    // Post-Access Edge Worker (`cloudflare_workers_route.api_keys_bypass_strip`)
    let originPath = currentPath;
    let originQuery = querySuffix;
    if (matchesWorkerRoute(workerRoutePattern, req.host, currentPath)) {
      const h = new Headers();
      for (const [k, vals] of Object.entries(forwardedHeaders)) {
        for (const v of vals) h.append(k, v);
      }
      const incoming = new Request(`https://${req.host}${currentPath}${querySuffix}`, {
        method: req.method ?? 'GET',
        headers: h,
      });
      let capturedOriginReq: Request | undefined;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedOriginReq = input instanceof Request ? (init ? new Request(input, init) : input) : new Request(input, init);
        return new Response('ok', { status: 200 });
      }) as typeof fetch;
      let workerResp: Response;
      try {
        workerResp = await workerModule.default.fetch(incoming);
      } finally {
        globalThis.fetch = origFetch;
      }
      if (!capturedOriginReq) {
        return { action: 'worker_block', status: workerResp.status, bypassesInteractiveAccess };
      }
      const parsed = new URL(capturedOriginReq.url);
      originPath = parsed.pathname;
      originQuery = parsed.search;
      for (const key of Object.keys(forwardedHeaders)) delete forwardedHeaders[key];
      capturedOriginReq.headers.forEach((value, key) => {
        forwardedHeaders[key.toLowerCase()] = [value];
      });
    }

    return {
      action: 'origin',
      app: winner.name,
      decision: effectiveDecision,
      bypassesInteractiveAccess,
      originPath,
      originQuery,
      forwardedHeaders,
    };
  }

  return { apiKeyBypassPaths, apiKeysBypassDestUri, workerRoutePattern, evaluate };
}

describe('A1 / A2 / S5b Cloudflare Access bypass is restricted to fk_ API keys on /api/v1 and /mcp (and webhooks)', () => {
  it('declares Cloudflare provider, wires FACTORY_ACCESS_AUD, and leaves edge resources disabled by default without plaintext secrets', () => {
    const mainTf = read('landing-zones/aws/main.tf');
    assert.match(mainTf, /cloudflare\s*=\s*\{\s*source\s*=\s*"cloudflare\/cloudflare"/);

    const cfTf = read('landing-zones/aws/cloudflare.tf');
    assert.match(cfTf, /provider\s+"cloudflare"\s*\{\s*\}/, 'cloudflare provider block must take credentials from env, not variables');
    assert.doesNotMatch(cfTf, /api_token\s*=|api_key\s*=/, 'cloudflare.tf must never set credential values in HCL');
    assert.doesNotMatch(cfTf, /CF_Authorization/i, 'cloudflare.tf must never check unverified CF_Authorization cookies');

    const varsTf = read('landing-zones/aws/variables.tf');
    const zoneVar = hclBlocks(varsTf, 'variable').find((v) => v.name === 'cloudflare_zone_id');
    assert.ok(zoneVar, 'variable cloudflare_zone_id must be declared');
    assert.match(zoneVar.body, /default\s*=\s*""/, 'cloudflare_zone_id must default to empty string');

    const outputsTf = read('landing-zones/aws/outputs.tf');
    const audOut = hclBlocks(outputsTf, 'output').find((o) => o.name === 'cloudflare_access_aud');
    assert.ok(audOut, 'outputs.tf must export cloudflare_access_aud');
    assert.match(
      audOut.body,
      /local\.cloudflare_enabled\s*\?\s*cloudflare_zero_trust_access_application\.factory\[0\]\.aud\s*:\s*""/,
      'cloudflare_access_aud output must export factory[0].aud when cloudflare_enabled',
    );

    const ecsTf = read('landing-zones/aws/ecs.tf');
    assert.match(
      ecsTf,
      /\{\s*name\s*=\s*"FACTORY_ACCESS_AUD",\s*value\s*=\s*var\.access_aud\s*!=\s*""\s*\?\s*var\.access_aud\s*:\s*\(local\.cloudflare_enabled\s*\?\s*cloudflare_zero_trust_access_application\.factory\[0\]\.aud\s*:\s*""\)\s*\}/,
      'ecs.tf must wire FACTORY_ACCESS_AUD from var.access_aud or cloudflare_zero_trust_access_application.factory[0].aud',
    );
  });

  it('uses only valid Cloudflare v5 policy decisions and restricts Access bypass to /.cf-fk-bypass/* and webhooks', async () => {
    const validDecisions = new Set(['allow', 'deny', 'non_identity', 'bypass']);
    const allTf = files('landing-zones/aws', (p) => p.endsWith('.tf'));
    const accessResources = allTf.flatMap((f) =>
      hclBlocks(read(f), 'resource')
        .filter((b) => b.type?.startsWith('cloudflare_zero_trust_access_'))
        .map((b) => ({ file: f, ...b })),
    );
    assert.ok(accessResources.length >= 3, 'expected root, webhooks_bypass, and api_keys_bypass Access applications');

    for (const r of accessResources) {
      const decisions = [...r.body.matchAll(/decision\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
      assert.ok(decisions.length > 0, `${r.type}.${r.name} must declare at least one policy decision`);
      for (const d of decisions) {
        assert.ok(
          validDecisions.has(d),
          `${r.type}.${r.name} uses invalid Cloudflare v5 Access policy decision "${d}" (must be allow, deny, non_identity, or bypass)`,
        );
      }
    }

    const root = accessResources.find((r) => r.type === 'cloudflare_zero_trust_access_application' && r.name === 'factory');
    assert.ok(root, 'missing root cloudflare_zero_trust_access_application.factory');
    assert.match(root.body, /uri\s*=\s*"\$\{local\.cloudflare_host\}\/\*"/);
    assert.match(root.body, /decision\s*=\s*"allow"/);
    assert.match(root.body, /decision\s*=\s*"non_identity"/, 'transitional service token policy must use decision = "non_identity"');
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

    const host = 'factory.example.com';
    const { apiKeyBypassPaths, apiKeysBypassDestUri, workerRoutePattern } = await loadCloudflareEdgeConfig(host);
    assert.deepEqual(
      apiKeyBypassPaths,
      ['/api/v1', '/api/v1/*', '/mcp'],
      'eligible external fk_ rewrite paths must be strictly /api/v1, /api/v1/*, and /mcp',
    );
    assert.equal(
      apiKeysBypassDestUri,
      `${host}/.cf-fk-bypass/*`,
      'api_keys_bypass Access application must only match the internal /.cf-fk-bypass/* prefix (never /api/v1* or /mcp directly)',
    );
    assert.equal(workerRoutePattern, `${host}/.cf-fk-bypass/*`);

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
    for (const forbidden of ['/*', '/', '/api/v1', '/api/v1/*', '/mcp', '/mcp/*', '/ui', '/healthz', '/.cf-fk-bypass/*', '/api/v1/hooks/../agents']) {
      assert.equal(validWebhook(forbidden), false, `expected non-webhook path ${forbidden} to fail validation`);
    }
  });

  it('pairs /.cf-fk-bypass/* with pre-Access URL rewrite, pre-Access WAF block, post-Access header sanitization, and prefix-stripping Worker without synthetic login redirects', () => {
    const cfTf = read('landing-zones/aws/cloudflare.tf');
    const resources = hclBlocks(cfTf, 'resource');
    const rulesets = resources.filter((b) => b.type === 'cloudflare_ruleset');
    assert.deepEqual(
      rulesets.map((r) => r.name).sort(),
      ['api_keys_bypass_guard', 'api_keys_bypass_rewrite', 'api_keys_header_sanitize'],
      'must declare rewrite, WAF guard, and late header sanitize rulesets (and no http_request_dynamic_redirect ruleset)',
    );
    assert.doesNotMatch(cfTf, /http_request_dynamic_redirect|\/cdn-cgi\/access\/login/, 'must rely on native Cloudflare Access login redirects');

    const rewrite = rulesets.find((r) => r.name === 'api_keys_bypass_rewrite')!;
    assert.equal(hclStringAttr(rewrite.body, 'phase'), 'http_request_transform');
    assert.equal(hclStringAttr(rewrite.body, 'action'), 'rewrite');
    assert.match(rewrite.body, /concat\(\\"\/\.cf-fk-bypass\\",\s*http\.request\.uri\.path\)/);

    const guard = rulesets.find((r) => r.name === 'api_keys_bypass_guard')!;
    assert.equal(hclStringAttr(guard.body, 'phase'), 'http_request_firewall_custom');
    assert.equal(hclStringAttr(guard.body, 'action'), 'block');

    const sanitize = rulesets.find((r) => r.name === 'api_keys_header_sanitize')!;
    assert.equal(hclStringAttr(sanitize.body, 'phase'), 'http_request_late_transform');
    assert.equal(hclStringAttr(sanitize.body, 'action'), 'rewrite');
    assert.match(sanitize.body, /"cf-access-jwt-assertion"\s*=\s*\{\s*operation\s*=\s*"remove"\s*\}/);
    assert.match(sanitize.body, /"cf-access-authenticated-user-email"\s*=\s*\{\s*operation\s*=\s*"remove"\s*\}/);

    assert.ok(resources.find((b) => b.type === 'cloudflare_workers_script' && b.name === 'api_keys_bypass_strip'));
    assert.ok(resources.find((b) => b.type === 'cloudflare_workers_route' && b.name === 'api_keys_bypass_strip'));
  });

  it('evaluates edge pipeline: only Bearer fk_ on /api/v1, /api/v1/*, /mcp (and webhooks) bypasses Access while forged cookies are rejected and non-fk_ flows stay on root Access', async () => {
    const host = 'factory.example.com';
    const { evaluate } = await loadCloudflareEdgeConfig(host);

    // 1. Positive cases: valid `Bearer fk_<token>` on `/api/v1`, `/api/v1/*`, and `/mcp` rewrites through `/.cf-fk-bypass`,
    //    bypasses interactive Access, strips spoofed `cf-access-*` headers, and arrives at origin with the original path & query!
    for (const { path, query } of [
      { path: '/api/v1', query: '' },
      { path: '/api/v1/whoami', query: '' },
      { path: '/api/v1/agents/higgins', query: '?verbose=1' },
      { path: '/api/v1/health', query: '' },
      { path: '/mcp', query: '' },
    ]) {
      const res = await evaluate({
        method: path === '/mcp' ? 'POST' : 'GET',
        host,
        path,
        query,
        headers: {
          authorization: 'Bearer fk_example_key_1',
          'cf-access-jwt-assertion': 'forged.jwt.value',
          'cf-access-authenticated-user-email': 'spoof@example.com',
        },
      });
      assert.equal(res.action, 'origin', `expected fk_ key on ${path} to reach origin`);
      assert.equal(res.app, 'api_keys_bypass');
      assert.equal(res.decision, 'bypass');
      assert.equal(res.bypassesInteractiveAccess, true, `expected fk_ key on ${path} to bypass interactive Access`);
      assert.equal(res.originPath, path, `Worker must restore canonical path ${path} before origin delivery`);
      assert.equal(res.originQuery, query, `Worker must preserve query string ${query}`);
      assert.equal(res.forwardedHeaders['cf-access-jwt-assertion'], undefined, 'spoofed cf-access-jwt-assertion must be stripped');
      assert.equal(res.forwardedHeaders['cf-access-authenticated-user-email'], undefined, 'spoofed email header must be stripped');
      assert.deepEqual(res.forwardedHeaders['authorization'], ['Bearer fk_example_key_1']);
    }

    // 2. Signature-verified webhook paths retain their Access bypass without an fk_ key and also strip spoofed cf-access-* headers (D22, A1, A2).
    for (const path of ['/api/v1/hooks/github', '/api/v1/hooks/switch']) {
      const res = await evaluate({
        method: 'POST',
        host,
        path,
        headers: {
          'x-hub-signature-256': 'sha256=deadbeef',
          'cf-access-jwt-assertion': 'forged.jwt.value',
        },
      });
      assert.equal(res.action, 'origin', `expected webhook path ${path} to reach origin`);
      assert.equal(res.app, 'webhooks_bypass');
      assert.equal(res.bypassesInteractiveAccess, true);
      assert.equal(res.forwardedHeaders['cf-access-jwt-assertion'], undefined);
    }

    // 3. Keyless unauthenticated requests (including OAuth callbacks with query strings) stay on root `factory` Access
    //    so Cloudflare Access issues a real `<team>.cloudflareaccess.com` login redirect preserving path & query string (F3, S5b).
    for (const { path, query } of [
      { path: '/api/v1', query: '' },
      { path: '/api/v1/whoami', query: '' },
      { path: '/api/v1/connections/google/callback', query: '?code=oauth_code_1&state=nonce_2' },
      { path: '/api/v1/health', query: '' },
      { path: '/mcp', query: '' },
      { path: '/mcp/tools', query: '' },
    ]) {
      const res = await evaluate({ host, path, query });
      assert.equal(res.action, 'access_challenge', `expected keyless request on ${path} to hit root Access challenge`);
      assert.equal(res.app, 'factory');
      assert.equal(res.preservedPathAndQuery, `${path}${query}`);
      assert.equal(res.bypassesInteractiveAccess, false);
    }

    // 4. Forged `Cookie: CF_Authorization=eyJ...`, non-fk_ credentials, malformed fk_ headers, traversal tricks,
    //    and direct external `/.cf-fk-bypass*` probes NEVER reach origin or bypass interactive Access (F2, F3)!
    const rejectedCases: Array<{ label: string; path: string; headers?: Record<string, string | string[]> }> = [
      { label: 'forged JWT-shaped CF_Authorization cookie on /api/v1/whoami', path: '/api/v1/whoami', headers: { cookie: 'CF_Authorization=eyJforged.payload.sig' } },
      { label: 'forged JWT-shaped CF_Authorization cookie on /api/v1/agents', path: '/api/v1/agents', headers: { cookie: 'CF_Authorization=eyJhbGciOiJSUzI1NiJ9.e30.forged' } },
      { label: 'forged JWT-shaped CF_Authorization cookie on /api/v1//health', path: '/api/v1//health', headers: { cookie: 'CF_Authorization=eyJforged' } },
      { label: 'forged JWT-shaped CF_Authorization cookie on /mcp', path: '/mcp', headers: { cookie: 'CF_Authorization=eyJforged' } },
      { label: 'legacy non-fk bearer', path: '/api/v1/whoami', headers: { authorization: 'Bearer legacy_shared_token' } },
      { label: 'OIDC JWT bearer without fk_', path: '/mcp', headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig' } },
      { label: 'empty fk_ suffix', path: '/api/v1/whoami', headers: { authorization: 'Bearer fk_' } },
      { label: 'whitespace-only fk_ suffix', path: '/api/v1/whoami', headers: { authorization: 'Bearer fk_   ' } },
      { label: 'internal space after fk_ token', path: '/mcp', headers: { authorization: 'Bearer fk_abc extra' } },
      { label: 'lowercase bearer scheme', path: '/api/v1/agents', headers: { authorization: 'bearer fk_example_key_1' } },
      { label: 'Basic auth scheme', path: '/api/v1/agents', headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { label: 'bare fk_ without Bearer prefix', path: '/mcp', headers: { authorization: 'fk_example_key_1' } },
      { label: 'duplicate Authorization header smuggling', path: '/api/v1/whoami', headers: { authorization: ['Bearer fk_example_key_1', 'Bearer other'] } },
      { label: 'unconfigured CF-Access-Client-Id without fk_ key', path: '/api/v1/whoami', headers: { 'cf-access-client-id': 'id', 'cf-access-client-secret': 'sec', authorization: 'Bearer old_tok' } },
      { label: 'subpath under /mcp', path: '/mcp/subpath', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'uppercase /API/V1 path', path: '/API/V1/whoami', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'uppercase /MCP path', path: '/MCP', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'literal dot-segment traversal /api/v1/../ui', path: '/api/v1/../ui', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'encoded dot-segment traversal /api/v1/%2e%2e/ui', path: '/api/v1/%2e%2e/ui', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'uppercase encoded traversal /api/v1/%2E%2E/ui', path: '/api/v1/%2E%2E/ui', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'encoded slash /api/v1/agents%2f..%2fui', path: '/api/v1/agents%2f..%2fui', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'encoded backslash /api/v1/agents%5c..%5cui', path: '/api/v1/agents%5c..%5cui', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'direct probe /.cf-fk-bypass/ui with fk_ key', path: '/.cf-fk-bypass/ui', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'direct probe /.cf-fk-bypass/healthz with fk_ key', path: '/.cf-fk-bypass/healthz', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'direct probe /.cf-fk-bypass/ root with fk_ key', path: '/.cf-fk-bypass/', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'direct probe /.cf-fk-bypass/api/v1/whoami without fk_ key', path: '/.cf-fk-bypass/api/v1/whoami' },
      { label: 'direct probe /.cf-fk-bypass/api/v1/hooks/github with fk_ key', path: '/.cf-fk-bypass/api/v1/hooks/github', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'direct probe uppercase /.CF-FK-BYPASS/api/v1/whoami with fk_ key', path: '/.CF-FK-BYPASS/api/v1/whoami', headers: { authorization: 'Bearer fk_example_key_1' } },
      { label: 'direct probe /.cf-fk-bypass/api/v1/../ui with fk_ key', path: '/.cf-fk-bypass/api/v1/../ui', headers: { authorization: 'Bearer fk_example_key_1' } },
    ];
    for (const c of rejectedCases) {
      const res = await evaluate({ host, path: c.path, headers: c.headers });
      assert.notEqual(res.action, 'origin', `expected '${c.label}' on ${c.path} NOT to reach origin`);
      assert.equal(res.bypassesInteractiveAccess, false, `expected '${c.label}' NOT to bypass interactive Access`);
    }

    // 5. All other paths remain gated by the root Cloudflare Access application even when carrying a valid `Bearer fk_...` key!
    for (const path of ['/', '/ui', '/ui/assets/app.js', '/healthz', '/metrics', '/.well-known/factory-cli', '/api/v2/agents', '/apiv1', '/mcp-other']) {
      for (const headers of [{}, { authorization: 'Bearer fk_example_key_1' }]) {
        const res = await evaluate({ host, path, headers });
        assert.equal(res.action, 'access_challenge', `expected ${path} (${Object.keys(headers).length ? 'with fk_' : 'anonymous'}) to hit root Access challenge`);
        assert.equal(res.app, 'factory');
        assert.equal(res.bypassesInteractiveAccess, false);
      }
    }

    // 6. Genuine cryptographically verified Access browser sessions reach `/ui`, `/api/v1/whoami`, `/api/v1/health`,
    //    and `POST /mcp` via the root `factory` Access application (`bypassesInteractiveAccess: false`) with Access JWT intact!
    for (const { method, path } of [
      { method: 'GET', path: '/ui' },
      { method: 'GET', path: '/api/v1/whoami' },
      { method: 'GET', path: '/api/v1/health' },
      { method: 'POST', path: '/mcp' },
    ]) {
      const res = await evaluate({
        method,
        host,
        path,
        authenticatedAccessSession: true,
        headers: {
          'cf-access-jwt-assertion': 'verified.cloudflare.jwt',
        },
      });
      assert.equal(res.action, 'origin', `expected authenticated Access browser session on ${method} ${path} to reach origin`);
      assert.equal(res.app, 'factory');
      assert.equal(res.decision, 'allow');
      assert.equal(res.bypassesInteractiveAccess, false);
      assert.equal(res.originPath, path);
      assert.deepEqual(res.forwardedHeaders['cf-access-jwt-assertion'], ['verified.cloudflare.jwt']);
    }

    // 7. Transitional `CF-Access-Client-Id` service tokens work on `/api/v1/*` and `/mcp` (`decision = "non_identity"`)
    //    ONLY when configured in `var.cloudflare_access_service_token_ids` (F1, D9).
    const withTransitionalToken = await loadCloudflareEdgeConfig(host, ['/api/v1/hooks/*'], {
      serviceTokenIds: ['example-token-id-1'],
    });
    for (const path of ['/api/v1/whoami', '/mcp']) {
      const allowed = await withTransitionalToken.evaluate({
        host,
        path,
        serviceTokenId: 'example-token-id-1',
        headers: { authorization: 'Bearer legacy_bootstrap_token' },
      });
      assert.equal(allowed.action, 'origin', `expected configured transitional service token on ${path} to pass root Access`);
      assert.equal(allowed.app, 'factory');
      assert.equal(allowed.decision, 'non_identity');
      assert.equal(allowed.bypassesInteractiveAccess, false);

      const denied = await withTransitionalToken.evaluate({
        host,
        path,
        serviceTokenId: 'example-unknown-id-2',
        headers: { authorization: 'Bearer legacy_bootstrap_token' },
      });
      assert.equal(denied.action, 'access_challenge', `expected unknown service token on ${path} to be rejected by root Access`);
      assert.equal(denied.bypassesInteractiveAccess, false);
    }

    // 8. Negative sanity checks on destination matcher so evaluator itself cannot be vacuous.
    assert.equal(matchesAccessDestination(`${host}/*`, host, '/ui').matched, true);
    assert.equal(matchesAccessDestination(`${host}/.cf-fk-bypass/*`, host, '/api/v1/whoami').matched, false);
    assert.equal(matchesAccessDestination(`other.example.com/.cf-fk-bypass/*`, host, '/.cf-fk-bypass/api/v1').matched, false);
  });
});
