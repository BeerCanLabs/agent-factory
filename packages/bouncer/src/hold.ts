import { payloadHash } from '@beercanlabs/factory-ledger';
import type { HeldRequest } from './approvals.js';
import { HELD_BODY_LIMIT, HELD_HEADERS, HELD_STORED_BODY_LIMIT, type HoldRequest } from './wire.js';

const isText = (contentType: string | undefined) => !contentType || /^(text\/|application\/(json|x-www-form-urlencoded|[\w.+-]*\+json))/i.test(contentType);

export type DescribedHold = { ok: true; argsSha256: string; request: HoldRequest['request'] } | { ok: false; limit: number };

/**
 * E9: the reviewable copy of a request to hold and the hash that makes a retry "the same" request: method, path, the
 * `HELD_HEADERS` present and the body (always the base64 of the raw bytes, whatever `bodyEncoding` is).
 */
export function describeHeldRequest(r: { method: string; path: string; headers: Record<string, string | string[] | undefined>; raw: Buffer }): DescribedHold {
  if (r.raw.length > HELD_BODY_LIMIT) return { ok: false, limit: HELD_BODY_LIMIT };
  const headers: Record<string, string> = {};
  for (const h of HELD_HEADERS) {
    const v = r.headers[h];
    if (typeof v === 'string') headers[h] = v;
  }
  const text = isText(headers['content-type']) && Buffer.from(r.raw.toString('utf8'), 'utf8').equals(r.raw);
  const body = text ? r.raw.toString('utf8') : r.raw.toString('base64');
  const argsSha256 = payloadHash({ method: r.method, path: r.path, headers, body: r.raw.toString('base64') });
  return { ok: true, argsSha256, request: { method: r.method, path: r.path, headers, body, bodyEncoding: text ? 'utf8' : 'base64' } };
}

export type ParsedHold = { route: string; argsSha256: string; request: Record<string, unknown> & { method: string; path: string; body: string; bodyEncoding: 'utf8' | 'base64' } };

/** The shape check for a hold sent by the gatekeeper-egress. The live-run check stays with the caller. */
export function parseHoldRequest(b: Record<string, unknown>): ParsedHold | undefined {
  const r = b.request as Record<string, unknown> | undefined;
  const valid =
    typeof b.route === 'string' && typeof b.argsSha256 === 'string' && /^[0-9a-f]{64}$/.test(b.argsSha256) &&
    r && typeof r.method === 'string' && typeof r.path === 'string' && typeof r.body === 'string' && (r.bodyEncoding === 'utf8' || r.bodyEncoding === 'base64') &&
    r.body.length <= HELD_STORED_BODY_LIMIT && (r.headers === undefined || (typeof r.headers === 'object' && r.headers !== null && !Array.isArray(r.headers)));
  if (!valid || !r) return undefined;
  return { route: b.route as string, argsSha256: b.argsSha256 as string, request: r as ParsedHold['request'] };
}

/** The stored copy of a held request. `redact` is the S1 backstop (the caller owns the secret values). */
export function heldCopyOf(parsed: ParsedHold, redact: (v: string) => string): HeldRequest {
  const r = parsed.request;
  const headers = Object.fromEntries(Object.entries((r.headers ?? {}) as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return {
    method: String(r.method).toUpperCase(),
    path: redact(String(r.path)),
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, redact(v)])),
    body: r.bodyEncoding === 'utf8' ? redact(String(r.body)) : String(r.body),
    bodyEncoding: r.bodyEncoding,
    ...(typeof r.preview === 'string' ? { preview: r.preview } : {}),
  };
}

/** The approval's `tool` text for a held request: the method and the path without its query. */
export function heldToolName(request: Pick<HeldRequest, 'method' | 'path'>): string {
  return `${request.method} ${request.path.split('?')[0]}`;
}
