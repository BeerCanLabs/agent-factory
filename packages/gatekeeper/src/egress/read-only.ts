/**
 * E3.1: a read-only egress route. Reads are forwarded; anything that could change the upstream is refused with
 * 403 `read_only_route` before a credential is injected. Built for the `github` route; fails closed on anything it
 * cannot classify.
 *
 * Allowed: GET and HEAD (except git push discovery), a git fetch (`POST …/git-upload-pack`), and a GraphQL request
 * (`POST …/graphql`) whose every operation is a query. Refused: every other method, git-receive-pack in any form,
 * GraphQL mutations and subscriptions, method-override headers, and any GraphQL body that does not parse.
 */
export type ReadOnlyVerdict = { ok: true } | { ok: false; why: string };

const METHOD_OVERRIDE = ['x-http-method-override', 'x-http-method', 'x-method-override'];

export function readOnlyVerdict(method: string | undefined, rest: string, headers: Record<string, unknown>, body: Buffer): ReadOnlyVerdict {
  const m = (method ?? '').toUpperCase();
  const q = rest.indexOf('?');
  let path: string;
  let query: string;
  try {
    path = decodeURIComponent(q < 0 ? rest : rest.slice(0, q)).toLowerCase();
    query = decodeURIComponent(q < 0 ? '' : rest.slice(q + 1)).toLowerCase();
  } catch {
    return { ok: false, why: 'unreadable_path' };
  }
  if (METHOD_OVERRIDE.some((h) => headers[h] !== undefined)) return { ok: false, why: 'method_override' };
  if (path.includes('git-receive-pack') || query.includes('git-receive-pack')) return { ok: false, why: 'git_push' };
  if (m === 'GET' || m === 'HEAD') return { ok: true };
  if (m === 'POST' && /\/git-upload-pack$/.test(path)) return { ok: true };
  if (m === 'POST' && /\/graphql\/?$/.test(path)) return graphqlIsReadOnly(body) ? { ok: true } : { ok: false, why: 'graphql_not_query' };
  return { ok: false, why: 'write_method' };
}

/** True only when the body is one JSON GraphQL request whose every top-level operation is a query. */
export function graphqlIsReadOnly(body: Buffer): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const doc = (parsed as { query?: unknown }).query;
  if (typeof doc !== 'string' || !doc.trim()) return false;
  return operationsAreQueries(doc);
}

/**
 * A small GraphQL lexer: comments and strings are skipped, then each top-level definition must start with `query`,
 * `fragment` or a bare selection set `{`. Anything unbalanced or unterminated fails closed.
 */
export function operationsAreQueries(doc: string): boolean {
  let i = 0;
  let depth = 0;
  let parens = 0;
  let expectingDefinition = true;
  let sawDefinition = false;
  while (i < doc.length) {
    const c = doc[i];
    if (c === '#') {
      while (i < doc.length && doc[i] !== '\n' && doc[i] !== '\r') i++;
      continue;
    }
    if (c === '"') {
      const block = doc.startsWith('"""', i);
      i += block ? 3 : 1;
      let closed = false;
      while (i < doc.length) {
        if (doc[i] === '\\') {
          i += 2;
          continue;
        }
        if (block ? doc.startsWith('"""', i) : doc[i] === '"') {
          i += block ? 3 : 1;
          closed = true;
          break;
        }
        if (!block && (doc[i] === '\n' || doc[i] === '\r')) return false;
        i++;
      }
      if (!closed) return false;
      continue;
    }
    if (c === '(') parens++;
    else if (c === ')' && --parens < 0) return false;
    else if (c === '{') {
      if (depth === 0 && parens === 0 && expectingDefinition) {
        expectingDefinition = false;
        sawDefinition = true;
      }
      depth++;
    } else if (c === '}') {
      if (--depth < 0) return false;
      if (depth === 0 && parens === 0) expectingDefinition = true;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < doc.length && /[A-Za-z0-9_]/.test(doc[j])) j++;
      const word = doc.slice(i, j);
      if (depth === 0 && parens === 0 && expectingDefinition) {
        if (word !== 'query' && word !== 'fragment') return false;
        expectingDefinition = false;
        sawDefinition = true;
      }
      i = j;
      continue;
    }
    i++;
  }
  return sawDefinition && depth === 0 && parens === 0 && expectingDefinition;
}
