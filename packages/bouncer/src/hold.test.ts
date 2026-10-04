import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { HELD_BODY_LIMIT, HELD_STORED_BODY_LIMIT, describeHeldRequest, heldCopyOf, heldToolName, parseHoldRequest } from './index.js';

const all = {
  'content-type': 'application/json',
  'x-restli-method': 'create',
  'x-http-method-override': 'POST',
  'x-http-method': 'POST',
  'x-method-override': 'POST',
  'linkedin-version': '202401',
};
const json = Buffer.from('{"a":1}');

// Pinned from the gatekeeper-egress's inline code before the move: an approved request must still match its retry (E9).
const PIN_JSON = 'e7d16a326dcf8fb99a4f4a97268bb3f9ea3c91f5d4027ca3a3062f5afb2b3396';
const PIN_BINARY = '1d10f85e5a4b22f4618ce43b7114adc6460e759d0da60cb1a6792dc1aaef3ea1';

function hashOf(headers: Record<string, string | string[] | undefined>, raw: Buffer, path = '/rest/posts') {
  const d = describeHeldRequest({ method: 'POST', path, headers, raw });
  assert.ok(d.ok);
  return d.argsSha256;
}

describe('describeHeldRequest', () => {
  it('pins the hash of a JSON POST with all six held headers', () => {
    assert.equal(hashOf(all, json), PIN_JSON);
  });

  it('a transport header leaves the hash unchanged', () => {
    assert.equal(hashOf({ ...all, 'x-request-id': 'abc' }, json), PIN_JSON);
  });

  it('x-http-method-override changes the hash', () => {
    assert.notEqual(hashOf({ ...all, 'x-http-method-override': 'DELETE' }, json), PIN_JSON);
  });

  it('pins the hash of a binary body', () => {
    assert.equal(hashOf({ 'content-type': 'application/octet-stream' }, Buffer.from([0, 255, 128, 1, 2]), '/rest/images'), PIN_BINARY);
  });

  it('keeps only the held headers, as strings', () => {
    const d = describeHeldRequest({ method: 'POST', path: '/p', headers: { ...all, 'x-request-id': 'abc', 'linkedin-version': ['a', 'b'] }, raw: json });
    assert.ok(d.ok);
    assert.equal(d.request.headers['x-request-id'], undefined);
    assert.equal(d.request.headers['linkedin-version'], undefined);
    assert.equal(d.request.headers['content-type'], 'application/json');
  });

  it('text stays utf8; binary and non-UTF-8 bytes become base64', () => {
    const t = describeHeldRequest({ method: 'POST', path: '/p', headers: all, raw: json });
    assert.ok(t.ok);
    assert.equal(t.request.bodyEncoding, 'utf8');
    assert.equal(t.request.body, '{"a":1}');
    const bin = Buffer.from([0, 255, 128, 1, 2]);
    const b = describeHeldRequest({ method: 'POST', path: '/p', headers: { 'content-type': 'application/octet-stream' }, raw: bin });
    assert.ok(b.ok);
    assert.equal(b.request.bodyEncoding, 'base64');
    assert.equal(b.request.body, bin.toString('base64'));
    const bad = describeHeldRequest({ method: 'POST', path: '/p', headers: { 'content-type': 'text/plain' }, raw: Buffer.from([255, 254]) });
    assert.ok(bad.ok);
    assert.equal(bad.request.bodyEncoding, 'base64');
  });

  it('refuses a body over the limit and accepts one at the limit', () => {
    const at = describeHeldRequest({ method: 'POST', path: '/p', headers: all, raw: Buffer.alloc(HELD_BODY_LIMIT, 97) });
    assert.ok(at.ok);
    const over = describeHeldRequest({ method: 'POST', path: '/p', headers: all, raw: Buffer.alloc(HELD_BODY_LIMIT + 1, 97) });
    assert.deepEqual(over, { ok: false, limit: HELD_BODY_LIMIT });
  });
});

const sha = 'a'.repeat(64);
const valid = () => ({ route: 'linkedin', argsSha256: sha, request: { method: 'post', path: '/p?x=1', body: 'hi', bodyEncoding: 'utf8', headers: { 'content-type': 'text/plain' } } });

describe('parseHoldRequest', () => {
  it('accepts a valid request, with or without headers, and one at the stored limit', () => {
    assert.ok(parseHoldRequest(valid()));
    const noHeaders = valid();
    delete (noHeaders.request as Record<string, unknown>).headers;
    assert.ok(parseHoldRequest(noHeaders));
    const atLimit = valid();
    atLimit.request.body = 'x'.repeat(HELD_STORED_BODY_LIMIT);
    assert.ok(parseHoldRequest(atLimit));
  });

  it('rejects each malformed field', () => {
    const bad: Array<(b: ReturnType<typeof valid>) => unknown> = [
      (b) => ({ ...b, route: 1 }),
      (b) => ({ ...b, argsSha256: 'abc' }),
      (b) => ({ ...b, argsSha256: 'A'.repeat(64) }),
      (b) => ({ ...b, argsSha256: 5 }),
      (b) => ({ ...b, request: undefined }),
      (b) => ({ ...b, request: { ...b.request, method: 1 } }),
      (b) => ({ ...b, request: { ...b.request, path: null } }),
      (b) => ({ ...b, request: { ...b.request, body: 1 } }),
      (b) => ({ ...b, request: { ...b.request, bodyEncoding: 'latin1' } }),
      (b) => ({ ...b, request: { ...b.request, body: 'x'.repeat(HELD_STORED_BODY_LIMIT + 1) } }),
      (b) => ({ ...b, request: { ...b.request, headers: [] } }),
      (b) => ({ ...b, request: { ...b.request, headers: null } }),
    ];
    for (const [i, f] of bad.entries()) assert.equal(parseHoldRequest(f(valid()) as Record<string, unknown>), undefined, `case ${i}`);
  });
});

describe('heldCopyOf and heldToolName', () => {
  const redact = (v: string) => v.replaceAll('SECRET', '[redacted]');

  it('masks a secret in the path, in a header and in a utf8 body', () => {
    const p = parseHoldRequest({ route: 'r', argsSha256: sha, request: { method: 'post', path: '/p/SECRET', headers: { a: 'SECRET', n: 5 }, body: 'x SECRET', bodyEncoding: 'utf8', preview: 'linkedin-post' } });
    assert.ok(p);
    const c = heldCopyOf(p, redact);
    assert.deepEqual(c, { method: 'POST', path: '/p/[redacted]', headers: { a: '[redacted]' }, body: 'x [redacted]', bodyEncoding: 'utf8', preview: 'linkedin-post' });
  });

  it('stores a base64 body as received', () => {
    const p = parseHoldRequest({ route: 'r', argsSha256: sha, request: { method: 'post', path: '/p', body: 'SECRET', bodyEncoding: 'base64' } });
    assert.ok(p);
    assert.equal(heldCopyOf(p, redact).body, 'SECRET');
    assert.equal('preview' in heldCopyOf(p, redact), false);
  });

  it('names the tool by method and path without its query', () => {
    assert.equal(heldToolName({ method: 'POST', path: '/rest/posts?a=1&b=2' }), 'POST /rest/posts');
  });
});
