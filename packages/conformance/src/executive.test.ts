// DESIGN_AUTHORITY.md §6.15 (Executive), GAP-119: the model catalog and request rules, the provider adapters and request
// signing, token counting, the model-policy gate and the serving of a call exist once, in packages/executive, and the
// dependency points one way: the gatekeeper-egress depends on the Executive.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getPackageClassification } from '@beercanlabs/factory-contract';
import { files, read } from './support.js';

// What this guard does and does not do, so the next reader does not mistake it for more:
//  - It reads TypeScript and JavaScript source (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) under every package's `src/` except
//    the Executive's own. Build output, tests and root-level config files are not read.
//  - It matches text, not syntax. A definition is found across line breaks where the layout is plain (`export const` on
//    one line and the name on the next, or a method whose parameters wrap), but a layout with nested parentheses in the
//    parameters, or a comment between the tokens, still passes. A rule copied under a different name passes too.
//  - It catches a rename only inside `import { … }` and `export { … }` lists, so an ordinary cast such as
//    `JSON.parse(raw) as ChatRequest` is a normal use of the Executive's types and is never reported.
//  - It does NOT guard `complete`, `Usage`, `Provider`, `Completion` or `CatalogEntry`. They are ordinary words or names
//    another member could legitimately use (the Keymaster has its own `CatalogEntry`). The Executive's `complete` and
//    `findModel` are covered by `findModel` and the literals below.
//  - It does NOT guard `upstream_error`, `upstream_throttled` or `provider_unavailable`. They are generic words another
//    member (the Keymaster, the control plane) could legitimately answer with. The adapters are guarded by what only they
//    write: `bedrock-runtime` and `AWS4-HMAC-SHA256`.
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

/** What only the Executive answers: the model-policy refusals and the chat-request validation. Generic codes are not here. */
const OWNED_CODES = 'model_not_allowed|model_pinned|messages_required|unsupported_role|unsupported_content';

/** A second copy of the Executive's rule. Each pattern is a definition or a literal, never a use. */
const SECOND_COPY: Array<{ what: string; re: RegExp }> = [
  { what: 'a function, constant or class the Executive owns, defined again', re: new RegExp(`\\b(?:function|const|let|var|class)\\s+(?:${OWNED_VALUES})\\b`, 'gm') },
  {
    what: 'a type the Executive owns, defined again',
    re: new RegExp(`\\b(?:interface)\\s+(?:${OWNED_TYPES})\\b|\\btype\\s+(?:${OWNED_TYPES})\\s*(?:<[^>]*>)?\\s*=`, 'gm'),
  },
  {
    what: 'an object method or property the Executive owns, defined again',
    re: new RegExp(`^[ \\t]*(?:async[ \\t]+)?(?:${OWNED_VALUES})\\s*(?:\\([^)]*\\)\\s*(?::\\s*[^{=;]+)?\\{|:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|\\w+\\s*=>))`, 'gm'),
  },
  { what: 'an answer of the model policy or the request validation, written again', re: new RegExp(`['"](?:${OWNED_CODES})['"]`, 'gm') },
  { what: 'AWS request signing, written again', re: /['"`]AWS4-HMAC-SHA256\b/gm },
  { what: 'the Bedrock endpoint, written again', re: /bedrock-runtime/gm },
  { what: 'Anthropic usage fields read again (token counting)', re: /\b(?:cache_read_input_tokens|cache_creation_input_tokens)\b/gm },
];

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;
const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ');

const matches = (src: string, patterns = SECOND_COPY) =>
  patterns.flatMap((c) => [...src.matchAll(c.re)].map((m) => `${lineOf(src, m.index ?? 0)}: ${oneLine(m[0])}  [${c.what}]`));

/** `import { x as checkModel }` and `export { x as signV4 }`, on one line or several; a cast `v as ChatRequest` is not one. */
const SPECIFIER_LIST = /\b(?:import|export)\s+(?:type\s+)?\{([^}]*)\}/g;
const RENAMED_TO_OWNED = new RegExp(`\\bas\\s+(?:${OWNED_VALUES}|${OWNED_TYPES})\\b`);
const renamed = (src: string) =>
  [...src.matchAll(SPECIFIER_LIST)]
    .filter((m) => RENAMED_TO_OWNED.test(m[1]))
    .map((m) => `${lineOf(src, m.index ?? 0)}: ${oneLine(m[0]).slice(0, 110)}  [an export or import renamed to a name the Executive owns]`);

const violations = (src: string) => [...matches(src), ...renamed(src)];

const nonTestSource = (p: string) => !/\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(p);
const NOT_EXECUTIVE = (p: string) => !p.startsWith('packages/executive/');
/** Any package's own source, wherever the rule could be copied to: not only the packages it came out of. */
const ANY_PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.*\.(?:ts|tsx|js|mjs|cjs)$/;
const executiveSource = () => files('packages/executive/src', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p));

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
      "return { ok: false, error: 'unsupported_role' };",
      "return { ok: false, error: 'messages_required' };",
      "headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${id}`;",
      'const endpoint = `https://bedrock-runtime.${region}.amazonaws.com`;',
      'cacheRead: n(u.cache_read_input_tokens),',
      'cacheWrite: n(u.cache_creation_input_tokens),',
      // renamed in an import or export list
      'export { sign as signV4 };',
      "import { somethingElse as checkModel } from './other.js';",
      'export { Policy as ModelPolicy } from "./policy.js";',
      'export {\n  sign as\n    signV4,\n};',
      // an object method or property
      '  checkModel(policy, model) {',
      '  async findModel(catalog, model) {',
      '  offeredModels(policy: P, names: string[]): string[] {',
      '  signV4: (req, creds) => sign(req, creds),',
      '  usageFromJson: function (provider, body) {',
      '  bedrockConverse: async (opts) => ({}),',
      // split across lines
      'export const\n  checkModel = (a, b) => a;',
      'export async function\n  findModel(c, m) {\n}',
      'const o = {\n  checkModel(\n    policy: P,\n    model: string,\n  ): ModelCheck {\n    return x;\n  },\n};',
    ];
    for (const src of forbidden) assert.equal(violations(src).length >= 1, true, `should be caught: ${JSON.stringify(src)}`);

    const allowed = [
      "import { checkModel, complete, findModel, offeredModels } from '@beercanlabs/factory-executive';",
      "import { ModelUpstreamError, SseMeter, usageFromJson, type ModelAdapter, type ModelCatalog } from '@beercanlabs/factory-executive';",
      "import { signV4 as sign } from '@beercanlabs/factory-executive';",
      'export { checkModel };',
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
      '  checkModel(policy, model);',
      '  if (checkModel(policy, model).allowed) {',
      '  const r = checkModel(policy, model, {',
      '  offeredModels(modelPolicyOf(ctx), Object.keys(catalog)).map((id) => ({ id })),',
      '  return findModel(catalog, model) ?? other;',
      '  complete: async (entry) => entry,',
      'foo(\n  checkModel(policy, model),\n  other,\n);',
      'const check =\n  checkModel(policy, model);',
      // a cast is a normal use of the Executive's types, not a rename
      'const body = JSON.parse(raw) as ChatRequest;',
      'const catalog = x as ModelCatalog;',
      'return { ...p } as ModelPolicy;',
      'const creds = (await load()) as AwsCredentials;',
      // generic answers other members may give
      "return send(res, 503, { error: 'provider_unavailable' });",
      "throw new Error('upstream_error');",
      "return send(res, 429, { error: 'upstream_throttled' });",
    ];
    for (const src of allowed) assert.deepEqual(violations(src), [], `should be allowed: ${JSON.stringify(src)}`);
  });

  it('every name the guard looks for is still defined somewhere in packages/executive, so the guard is not vacuous', () => {
    // Anywhere in the package's source, not in a named file: moving code to a new file inside the Executive is not a second copy.
    const found = executiveSource().flatMap((f) => violations(read(f)));
    const names = [
      ...OWNED_VALUES.split('|'),
      ...OWNED_TYPES.split('|'),
      ...OWNED_CODES.split('|'),
      'AWS4-HMAC-SHA256',
      'bedrock-runtime',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ];
    for (const name of names) assert.ok(found.some((m) => m.includes(name)), `packages/executive no longer defines ${name}, so the guard no longer looks for it anywhere`);
  });

  it('no package but the Executive defines its rules again or writes the literals only it writes', () => {
    const found = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p) && NOT_EXECUTIVE(p)).flatMap((f) =>
      violations(read(f)).map((m) => `${f}:${m}`),
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
    const scanned = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p) && NOT_EXECUTIVE(p));
    for (const must of ['packages/gatekeeper-egress/src/gatekeeper-egress.ts', 'packages/control-plane/src/app.ts', 'packages/budget/src/index.ts', 'packages/inspector/src/index.ts']) {
      assert.ok(scanned.includes(must), `the scan no longer reaches ${must}`);
    }
  });

  it('packages/executive is attributed to the Executive, and to nothing else, so its files have one owner', () => {
    // `owns` lists files only in the two shared packages (control-plane, gatekeeper-egress). A package of the member's own is
    // owned through `hostedIn`, and this is the check that it still is.
    assert.deepEqual(getPackageClassification('executive'), { services: ['executive'] });
  });

  it('packages/executive depends on no control-plane, gatekeeper or console package, in its manifest or its source', () => {
    const pkg = JSON.parse(read('packages/executive/package.json')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    const back = names.filter((n) => /^@beercanlabs\/factory-(control-plane|gatekeeper-.+|console)$/.test(n));
    assert.deepEqual(back, [], 'the dependency points one way: the gatekeeper-egress depends on the Executive');

    // Any way of reaching those packages: `from`, a bare `import 'x'`, `import('x')` and `require('x')`, on one line or several;
    // by package name (with or without a deep path) or by a relative path (with or without `packages/`).
    const SPEC =
      "(?:@beercanlabs\\/factory-(?:control-plane|gatekeeper-[a-z-]+|console)|(?:\\.\\.\\/)+(?:packages\\/)?(?:control-plane|gatekeeper-[a-z-]+|console))(?=\\/|['\"])";
    const IMPORT_BACK = new RegExp(`\\b(?:from|import|require)\\s*\\(?\\s*['"]${SPEC}`, 'g');
    const backImports = (src: string) =>
      [...src.matchAll(IMPORT_BACK)]
        .filter((m) => {
          const at = m.index ?? 0;
          const lineStart = src.lastIndexOf('\n', at - 1) + 1;
          return !/^\s*(?:\/\/|\/\*|\*)/.test(src.slice(lineStart, at + 1)); // a commented-out line is not an import
        })
        .map((m) => `${lineOf(src, m.index ?? 0)}: ${oneLine(m[0])}`);

    // Built from pieces, so this file holds no literal cross-package specifier for the imports check to read as a real import.
    const spec = (name: string) => ['@beercanlabs', `factory-${name}`].join('/');
    const upToEgress = ['..', '..', 'gatekeeper-egress', 'src', 'gatekeeper-egress.js'].join('/');
    const upThroughPackages = ['..', '..', '..', 'packages', 'gatekeeper-egress', 'src', 'a.js'].join('/');
    const caught = [
      `import { x } from '${spec('gatekeeper-egress')}';`,
      `import { x } from '${spec('gatekeeper-egress')}/dist/x.js';`,
      `import { x } from '${upToEgress}';`,
      `import { x } from '${upThroughPackages}';`,
      `export { x } from '${spec('control-plane')}';`,
      `import '${spec('console')}';`,
      `const m = await import('${spec('gatekeeper-ingress')}');`,
      `const m = require('${spec('control-plane')}');`,
      `import {\n  x,\n} from\n  '${spec('gatekeeper-egress')}';`,
    ];
    for (const src of caught) assert.equal(backImports(src).length, 1, `should be caught: ${JSON.stringify(src)}`);
    const fine = [
      `import type { Price } from '${spec('budget')}';`,
      "import { x } from './models.js';",
      "import { signV4 } from './sigv4.js';",
      "const note = 'the gatekeeper-egress depends on the Executive';",
      `// import { x } from '${spec('console')}';`,
      ` * import { x } from '${spec('gatekeeper-egress')}';`,
      `const label = '${spec('console-extras')}';`,
    ];
    for (const src of fine) assert.deepEqual(backImports(src), [], `should be allowed: ${JSON.stringify(src)}`);
    assert.equal(backImports(`import a from '${spec('control-plane')}';\nimport b from '${upToEgress}';`).length, 2, 'every violation is reported, not only the first in a file');

    const imports = executiveSource().flatMap((f) => backImports(read(f)).map((m) => `${f}:${m}`));
    assert.deepEqual(imports, [], 'the Executive takes what it needs from another member as plain values or a structural type, never by importing it');
  });
});
