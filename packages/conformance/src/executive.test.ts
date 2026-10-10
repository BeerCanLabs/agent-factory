// DESIGN_AUTHORITY.md §6.15 (Executive), GAP-119: the model catalog and request rules, the provider adapters and request
// signing, token counting, the model-policy gate and the serving of a call exist once, in packages/executive, and the
// dependency points one way: the gatekeeper-egress depends on the Executive.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

// What this guard does not do, so the next reader does not mistake it for more:
//  - It is line-based. A rule copied under a different name passes. It sees definitions of the Executive's own names
//    (functions, classes, types, object methods and properties, and anything exported or imported under one of those
//    names) and the literals only the Executive writes today.
//  - It reads TypeScript and JavaScript source (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) under every package's `src/` except
//    the Executive's own. Build output, tests and root-level config files are not read.
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
  { what: 'an export or import renamed to a name the Executive owns', re: new RegExp(`\\bas\\s+(?:${OWNED_VALUES}|${OWNED_TYPES})\\b`) },
  {
    what: 'an object method or property the Executive owns, defined again',
    re: new RegExp(`^\\s*(?:async\\s+)?(?:${OWNED_VALUES})\\s*(?:\\([^)]*\\)\\s*(?::\\s*[^{=]+)?\\{|:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|\\w+\\s*=>))`),
  },
  { what: 'an answer or refusal of the model policy or the adapters, written again', re: new RegExp(`['"](?:${OWNED_CODES})['"]`) },
  { what: 'AWS request signing, written again', re: /['"`]AWS4-HMAC-SHA256\b/ },
  { what: 'the Bedrock endpoint, written again', re: /bedrock-runtime/ },
  { what: 'Anthropic usage fields read again (token counting)', re: /\b(?:cache_read_input_tokens|cache_creation_input_tokens)\b/ },
];

const matches = (src: string, patterns = SECOND_COPY) =>
  src.split('\n').flatMap((line, i) => patterns.filter((c) => c.re.test(line)).map((c) => `${i + 1}: ${line.trim()}  [${c.what}]`));

const NOT_EXECUTIVE = (p: string) => !p.startsWith('packages/executive/');
/** Any package's own source, wherever the rule could be copied to: not only the packages it came out of. */
const ANY_PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.*\.(?:ts|tsx|js|mjs|cjs)$/;
const nonTestSource = (p: string) => !/\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(p);

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
      'export { sign as signV4 };',
      "import { somethingElse as checkModel } from './other.js';",
      'export { Policy as ModelPolicy } from "./policy.js";',
      '  checkModel(policy, model) {',
      '  async findModel(catalog, model) {',
      '  offeredModels(policy: P, names: string[]): string[] {',
      '  signV4: (req, creds) => sign(req, creds),',
      '  usageFromJson: function (provider, body) {',
      '  bedrockConverse: async (opts) => ({}),',
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
      "import { signV4 as sign } from '@beercanlabs/factory-executive';",
      'export { checkModel };',
      '  checkModel(policy, model);',
      '  if (checkModel(policy, model).allowed) {',
      '  const r = checkModel(policy, model, {',
      '  offeredModels(modelPolicyOf(ctx), Object.keys(catalog)).map((id) => ({ id })),',
      '  return findModel(catalog, model) ?? other;',
      '  complete: async (entry) => entry,',
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
      ['packages/executive/src/complete.ts', 'upstream_error'],
      ['packages/executive/src/models.ts', 'upstream_error'],
      ['packages/executive/src/models.ts', 'unsupported_content'],
      ['packages/executive/src/models.ts', 'messages_required'],
    ];
    for (const [file, name] of originals) {
      assert.ok(matches(read(file)).some((m) => m.includes(name)), `${file} no longer carries ${name} where the guard looks for it`);
    }
  });

  it("no package but the Executive defines its rules again or writes the literals only it writes", () => {
    const found = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p) && NOT_EXECUTIVE(p)).flatMap((f) =>
      matches(read(f)).map((m) => `${f}:${m}`),
    );
    assert.deepEqual(
      found,
      [],
      "the model catalog, the adapters, signing, token counting, the policy gate and the serving of a call are the Executive's: import them from @beercanlabs/factory-executive",
    );
  });

  it('the file scope reaches every package and every source extension, and skips only tests and the Executive itself', () => {
    for (const ok of ['packages/keymaster/src/x.ts', 'packages/budget/src/a/b.ts', 'packages/console/src/view.tsx', 'packages/hydrate/src/shim.js', 'packages/x/src/y.mjs', 'packages/x/src/y.cjs']) {
      assert.equal(ANY_PACKAGE_SOURCE.test(ok) && nonTestSource(ok) && NOT_EXECUTIVE(ok), true, `should be read: ${ok}`);
    }
    for (const skipped of ['packages/executive/src/models.ts', 'packages/keymaster/src/x.test.ts', 'packages/x/src/y.test.mjs', 'packages/x/dist/y.js', 'packages/console/postcss.config.js']) {
      assert.equal(ANY_PACKAGE_SOURCE.test(skipped) && nonTestSource(skipped) && NOT_EXECUTIVE(skipped), false, `should be skipped: ${skipped}`);
    }
    // ... and it is not vacuous: it finds the real source of the packages that came closest to hosting this code.
    const read_ = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p) && NOT_EXECUTIVE(p));
    for (const must of ['packages/gatekeeper-egress/src/gatekeeper-egress.ts', 'packages/control-plane/src/app.ts', 'packages/budget/src/index.ts', 'packages/inspector/src/index.ts']) {
      assert.ok(read_.includes(must), `the scan no longer reaches ${must}`);
    }
  });

  it('packages/executive depends on no control-plane, gatekeeper or console package, in its manifest or its source', () => {
    const pkg = JSON.parse(read('packages/executive/package.json')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    const back = names.filter((n) => /^@beercanlabs\/factory-(control-plane|gatekeeper-.+|console)$/.test(n));
    assert.deepEqual(back, [], 'the dependency points one way: the gatekeeper-egress depends on the Executive');

    // Any way of reaching those packages: `from`, a bare `import 'x'`, `import('x')` and `require('x')`, on one line or several.
    const SPEC = "(?:@beercanlabs\\/factory-(?:control-plane|gatekeeper-[a-z-]+|console)|(?:\\.\\.\\/)+(?:control-plane|gatekeeper-[a-z-]+|console))\\b";
    const IMPORT_BACK = new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*['"]${SPEC}`);
    // Built from pieces, so this file holds no literal cross-package specifier for the imports check to read as a real import.
    const spec = (name: string) => ['@beercanlabs', `factory-${name}`].join('/');
    const upToEgress = ['..', '..', 'gatekeeper-egress', 'src', 'gatekeeper-egress.js'].join('/');
    const caught = [
      `import { x } from '${spec('gatekeeper-egress')}';`,
      `import { x } from '${upToEgress}';`,
      `export { x } from '${spec('control-plane')}';`,
      `import '${spec('console')}';`,
      `const m = await import('${spec('gatekeeper-ingress')}');`,
      `const m = require('${spec('control-plane')}');`,
      `import {\n  x,\n} from\n  '${spec('gatekeeper-egress')}';`,
    ];
    for (const src of caught) assert.equal(IMPORT_BACK.test(src), true, `should be caught: ${src}`);
    const fine = [
      `import type { Price } from '${spec('budget')}';`,
      "import { x } from './models.js';",
      "import { signV4 } from './sigv4.js';",
      "const note = 'the gatekeeper-egress depends on the Executive';",
      `// a note about ${spec('console')}, not an import`,
    ];
    for (const src of fine) assert.equal(IMPORT_BACK.test(src), false, `should be allowed: ${src}`);
    const imports = files('packages/executive/src', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p)).flatMap((f) => {
      const hit = IMPORT_BACK.exec(read(f));
      return hit ? [`${f}: ${hit[0].replace(/\s+/g, ' ')}`] : [];
    });
    assert.deepEqual(imports, [], 'the Executive takes what it needs from another member as plain values or a structural type, never by importing it');
  });
});
