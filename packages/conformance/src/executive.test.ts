// DESIGN_AUTHORITY.md §6.15 (Executive), GAP-119: the model catalog and request rules, the provider adapters and request
// signing, token counting, the model-policy gate and the serving of a call exist once, in packages/executive, and the
// dependency points one way: the gatekeeper-egress depends on the Executive.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

// What this guard does not do, so the next reader does not mistake it for more:
//  - It is line-based. A rule copied under another name passes. It sees definitions of the Executive's own names and
//    literals only the Executive writes today.
//  - It does NOT guard `complete`, `Usage`, `Provider`, `Completion` or `CatalogEntry`. They are ordinary words or names
//    another member could legitimately use (the Keymaster has its own `CatalogEntry`), so guarding them would raise false
//    alarms. The Executive's `complete` and `findModel` are covered by their literals below.
//  - It does NOT guard `FACTORY_MODEL_CATALOG`. The egress's `main.ts` is the composition root: it reads the operations
//    config (M3) and hands the string to the Executive's `parseModelCatalog`. Reading it is not a second copy of the rule.
//  - It does NOT guard `'model_not_offered'`. That is the egress's own refusal when `findModel` finds nothing; the
//    Executive answers "not found", the Gatekeeper answers the request.
//  - It does NOT guard `prompt_tokens` and `completion_tokens`. The egress builds the OpenAI-format response body in
//    `handleModels`, which stays the Gatekeeper's handler.

/** Names the Executive owns. A definition of any of them outside the package is a second copy. */
const OWNED_VALUES =
  'signV4|awsCredentialsFromEnv|SseMeter|usageFromJson|parseModelCatalog|parseChatRequest|defaultModelAdapters|bedrockConverse|toConverse|fromConverse|checkModel|offeredModels|findModel|ModelUpstreamError';
const OWNED_TYPES = 'ChatRequest|ChatResult|ChatMessage|ModelAdapter|ModelCatalog|ModelPolicy|ModelCheck|AwsCredentials|BedrockConverseOptions';

/** The answers and the refusals the Executive writes. The egress passes them on; it never writes them. */
const OWNED_CODES = 'model_not_allowed|model_pinned|provider_unavailable|upstream_throttled|upstream_error|unsupported_role|unsupported_content|messages_required';

/** A second copy of the Executive's rule. Each pattern is a definition or a literal, never a use. */
const SECOND_COPY: Array<{ what: string; re: RegExp }> = [
  { what: 'a function, constant or class the Executive owns, defined again', re: new RegExp(`\\b(?:function|const|let|var|class)\\s+(?:${OWNED_VALUES})\\b`) },
  {
    what: 'a type the Executive owns, defined again',
    re: new RegExp(`\\b(?:interface)\\s+(?:${OWNED_TYPES})\\b|\\btype\\s+(?:${OWNED_TYPES})\\s*(?:<[^>]*>)?\\s*=`),
  },
  { what: 'an answer or refusal of the model policy or the adapters, written again', re: new RegExp(`['"](?:${OWNED_CODES})['"]`) },
  { what: 'AWS request signing, written again', re: /['"`]AWS4-HMAC-SHA256\b/ },
  { what: 'the Bedrock endpoint, written again', re: /bedrock-runtime/ },
  { what: 'Anthropic usage fields read again (token counting)', re: /\b(?:cache_read_input_tokens|cache_creation_input_tokens)\b/ },
];

const matches = (src: string, patterns = SECOND_COPY) =>
  src.split('\n').flatMap((line, i) => patterns.filter((c) => c.re.test(line)).map((c) => `${i + 1}: ${line.trim()}  [${c.what}]`));

const nonTest = (p: string) => !p.endsWith('.test.ts');
const NOT_EXECUTIVE = (p: string) => !p.startsWith('packages/executive/');
/** Where the rule used to live and could be copied back: the other members' source. */
const GUARDED = /^packages\/(control-plane|gatekeeper-egress|gatekeeper-ingress)\/src\/.*\.ts$/;
/** Any package's own source: for the literals only the Executive writes. */
const ANY_PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.*\.ts$/;

describe('Executive: one copy of the model service rules', () => {
  it('the patterns recognize what they exist to forbid, and not what callers legitimately do', () => {
    const forbidden = [
      'export function signV4(req, creds, scope) {',
      'const awsCredentialsFromEnv = () => async () => creds;',
      'export class SseMeter {',
      'function usageFromJson(provider, body) {',
      'export function parseModelCatalog(json) {',
      'function parseChatRequest(body) {',
      'const defaultModelAdapters = () => ({});',
      'export function bedrockConverse(opts = {}) {',
      'function toConverse(req) {',
      'function fromConverse(body) {',
      'export function checkModel(policy, model) {',
      'function offeredModels(policy, names) {',
      'const findModel = (catalog, model) => catalog[model];',
      'export class ModelUpstreamError extends Error {',
      'export type ChatRequest = { messages: ChatMessage[] };',
      'type ModelAdapter = { complete(entry, req): Promise<ChatResult> };',
      'interface ModelPolicy {',
      'type AwsCredentials = { accessKeyId: string };',
      "if (!allowed.includes(model)) return [403, 'model_not_allowed', { model }];",
      'return deny(res, ctx, route, 403, "model_pinned", { model });',
      "return { ok: false, status: 503, code: 'provider_unavailable' };",
      "throw new Error('upstream_throttled');",
      "return { ok: false, error: 'unsupported_role' };",
      "headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${id}`;",
      "const endpoint = `https://bedrock-runtime.${region}.amazonaws.com`;",
      'cacheRead: n(u.cache_read_input_tokens),',
      'cacheWrite: n(u.cache_creation_input_tokens),',
    ];
    for (const line of forbidden) assert.equal(matches(line).length >= 1, true, `should be caught: ${line}`);

    const allowed = [
      "import { checkModel, complete, findModel, offeredModels } from '@beercanlabs/factory-executive';",
      "import { ModelUpstreamError, SseMeter, usageFromJson, type ModelAdapter, type ModelCatalog } from '@beercanlabs/factory-executive';",
      'const check = checkModel(modelPolicyOf(ctx), model);',
      'if (!check.allowed) return deny(res, ctx, route, check.status, check.code, check.detail);',
      'const offered = offeredModels(modelPolicyOf(ctx), Object.keys(catalog));',
      'const entry = findModel(catalog, model);',
      'const done = await complete({ entry, adapters: modelAdapters, body: parsed });',
      "if (!entry) return deny(res, ctx, route, 400, 'model_not_offered', { model });",
      "if (!price) return deny(res, ctx, route, 403, 'unpriced_model', { model });",
      "if (throttled(ctx)) return deny(res, ctx, route, 429, 'throttled');",
      'const modelCatalog = parseModelCatalog(process.env.FACTORY_MODEL_CATALOG);',
      'usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },',
      'export function complete(args) {',
      'type Usage = { total: number };',
    ];
    for (const line of allowed) assert.deepEqual(matches(line), [], `should be allowed: ${line}`);
  });

  it('the patterns see the real originals in packages/executive, so they are not vacuous', () => {
    const originals: Array<[string, string]> = [
      ['packages/executive/src/sigv4.ts', 'signV4'],
      ['packages/executive/src/sigv4.ts', 'awsCredentialsFromEnv'],
      ['packages/executive/src/sigv4.ts', 'AWS4-HMAC-SHA256'],
      ['packages/executive/src/sigv4.ts', 'AwsCredentials'],
      ['packages/executive/src/meter.ts', 'SseMeter'],
      ['packages/executive/src/meter.ts', 'usageFromJson'],
      ['packages/executive/src/meter.ts', 'cache_read_input_tokens'],
      ['packages/executive/src/models.ts', 'parseModelCatalog'],
      ['packages/executive/src/models.ts', 'parseChatRequest'],
      ['packages/executive/src/models.ts', 'toConverse'],
      ['packages/executive/src/models.ts', 'fromConverse'],
      ['packages/executive/src/models.ts', 'bedrockConverse'],
      ['packages/executive/src/models.ts', 'defaultModelAdapters'],
      ['packages/executive/src/models.ts', 'ModelUpstreamError'],
      ['packages/executive/src/models.ts', 'ChatRequest'],
      ['packages/executive/src/models.ts', 'ModelAdapter'],
      ['packages/executive/src/models.ts', 'bedrock-runtime'],
      ['packages/executive/src/models.ts', 'unsupported_role'],
      ['packages/executive/src/models.ts', 'upstream_throttled'],
      ['packages/executive/src/model-policy.ts', 'checkModel'],
      ['packages/executive/src/model-policy.ts', 'offeredModels'],
      ['packages/executive/src/model-policy.ts', 'ModelPolicy'],
      ['packages/executive/src/model-policy.ts', 'model_not_allowed'],
      ['packages/executive/src/model-policy.ts', 'model_pinned'],
      ['packages/executive/src/complete.ts', 'findModel'],
      ['packages/executive/src/complete.ts', 'provider_unavailable'],
    ];
    for (const [file, name] of originals) {
      assert.ok(matches(read(file)).some((m) => m.includes(name)), `${file} no longer carries ${name} where the guard looks for it`);
    }
  });

  it("control-plane, gatekeeper-egress and gatekeeper-ingress source do not define the Executive's rules again", () => {
    const found = files('packages', (p) => GUARDED.test(p) && nonTest(p)).flatMap((f) => matches(read(f)).map((m) => `${f}:${m}`));
    assert.deepEqual(found, [], "the model catalog, the adapters, signing, token counting, the policy gate and the serving of a call are the Executive's: import them from @beercanlabs/factory-executive");
  });

  it("no other package writes the literals only the Executive writes (the signing scheme, the Bedrock host, Anthropic's usage fields)", () => {
    const LITERALS = SECOND_COPY.filter((c) => /signing|Bedrock|Anthropic|answer or refusal/.test(c.what));
    const found = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTest(p) && NOT_EXECUTIVE(p)).flatMap((f) =>
      matches(read(f), LITERALS).map((m) => `${f}:${m}`),
    );
    assert.deepEqual(found, [], 'these belong to packages/executive alone');
  });

  it('packages/executive depends on no control-plane, gatekeeper or console package, in its manifest or its source', () => {
    const pkg = JSON.parse(read('packages/executive/package.json')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    const back = names.filter((n) => /^@beercanlabs\/factory-(control-plane|gatekeeper-.+|console)$/.test(n));
    assert.deepEqual(back, [], 'the dependency points one way: the gatekeeper-egress depends on the Executive');

    const IMPORT_BACK = /\bfrom\s+['"](?:@beercanlabs\/factory-(?:control-plane|gatekeeper-[a-z-]+|console)|(?:\.\.\/)+(?:control-plane|gatekeeper-[a-z-]+|console))\b/;
    assert.equal(IMPORT_BACK.test("import { x } from '@beercanlabs/factory-gatekeeper-egress';"), true);
    const upToEgress = ['..', '..', 'gatekeeper-egress', 'src', 'gatekeeper-egress.js'].join('/'); // built, so this file holds no relative cross-package import itself
    assert.equal(IMPORT_BACK.test(`import { x } from '${upToEgress}';`), true);
    assert.equal(IMPORT_BACK.test("import type { Price } from '@beercanlabs/factory-budget';"), false);
    assert.equal(IMPORT_BACK.test("import { x } from './models.js';"), false);
    const imports = files('packages/executive/src', (p) => p.endsWith('.ts') && nonTest(p)).flatMap((f) =>
      read(f).split('\n').filter((l) => IMPORT_BACK.test(l)).map((l) => `${f}: ${l.trim()}`),
    );
    assert.deepEqual(imports, [], 'the Executive takes what it needs from another member as plain values or a structural type, never by importing it');
  });
});
