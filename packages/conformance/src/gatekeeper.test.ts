// DESIGN_AUTHORITY.md §6.15 (Gatekeeper), GAP-134: the perimeter's rules (the run-token contract, the policy store and
// its validation, the egress and the ingress) exist once, in packages/gatekeeper, and the dependency points one way: the
// control plane and the other members' callers depend on the Gatekeeper, never the reverse.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

// What this guard does and does not do, so the next reader does not mistake it for more:
//  - It reads TypeScript and JavaScript source (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) under every package's `src/` except
//    the Gatekeeper's own. Build output, tests and root-level config files are not read.
//  - It matches text, not syntax. A definition is found where the layout is plain (`export function` and the name on the
//    same line), but a rule copied under a different name passes, and so does a definition split over lines.
//  - It does NOT guard `packages/auth` (`RunTokens`, `bearerAuth`, the roles): the Gatekeeper's authentication package,
//    hosted by it as `packages/telemetry` is by the Inspector, and a package of its own.
//  - It does NOT guard the HTTP handlers that call the Gatekeeper (`authenticateRun`, the identity-links and policy
//    routes in `control-plane`): the Bouncer's privileges and the Auditor's ledger rows meet a request there (GAP-133).
//  - It does NOT guard the identity-link store: it is in `packages/bouncer` (GAP-136).
//  - It allows NO place outside the Gatekeeper to verify a run token itself. The Keymaster used to (GAP-137, TSK-201): it
//    could not use the contract, because the Gatekeeper depends on the Keymaster (the sign-in link rule), so the reverse
//    would be a cycle. Its check was removed instead; the caller verifies the run before it asks the Keymaster.
//    The list below is empty; adding to it needs a gap.

/** Names the Gatekeeper owns. A definition of any of them outside the package is a second copy. */
const OWNED_VALUES = [
  // the run-token contract
  'verifyRun',
  // the policy store and its validation
  'PolicyStore', 'validatePolicy', 'isReservedPolicyId', 'GLOBAL_POLICY_ID',
  // the two perimeter processes
  'createGatekeeperEgress', 'createGatekeeperIngress',
].join('|');

/** Where a run token may be checked outside the Gatekeeper, and why. Nowhere (GAP-137 removed the Keymaster's). */
const RUN_TOKEN_EXCEPTIONS: string[] = [];

/** A second copy of the Gatekeeper's code: a definition of a name it owns, or a run token checked by hand. Never a use. */
const SECOND_COPY: Array<{ what: string; re: RegExp }> = [
  { what: 'a function, constant or class the Gatekeeper owns, defined again', re: new RegExp(`\\b(?:function|const|let|var|class)\\s+(?:${OWNED_VALUES})\\b`, 'gm') },
  { what: 'a run token verified by hand (call verifyRun)', re: /\.runTokens\.verify\s*\(/g },
];

/** Packages the Gatekeeper must never import: the callers it serves and the members that sit above the perimeter. */
const FORBIDDEN_IMPORTS =
  /['"]@beercanlabs\/factory-(?:control-plane|console|property-manager|timekeeper|bench)(?:\/[^'"]*)?['"]/g;

/** Any way of reaching the Gatekeeper, by package name, with or without a subpath. */
const IMPORTS_GATEKEEPER = /['"]@beercanlabs\/factory-gatekeeper(?:\/[^'"]*)?['"]/g;

/** The packages the Gatekeeper depends on (and the reverse must never hold). */
const BELOW_THE_GATEKEEPER = ['auth', 'bouncer', 'budget', 'executive', 'inspector', 'keymaster', 'ledger', 'registrar', 'secrets-bind', 'telemetry'];

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;
const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ');
const matches = (src: string, patterns: Array<{ what: string; re: RegExp }>) =>
  patterns.flatMap((c) => [...src.matchAll(c.re)].map((m) => `${lineOf(src, m.index ?? 0)}: ${oneLine(m[0])}  [${c.what}]`));

const nonTestSource = (p: string) => !/\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(p);
const NOT_GATEKEEPER = (p: string) => !p.startsWith('packages/gatekeeper/');
const ANY_PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.*\.(?:ts|tsx|js|mjs|cjs)$/;
const gatekeeperSource = () => files('packages/gatekeeper/src', (p) => ANY_PACKAGE_SOURCE.test(p));
const manifestDeps = (pkg: string) => {
  const m = JSON.parse(read(`packages/${pkg}/package.json`)) as Record<string, Record<string, string> | undefined>;
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(m[k] ?? {}));
};

describe('Gatekeeper: one copy of the perimeter rules, and the dependency points one way', () => {
  it('the patterns recognize what they exist to forbid, and not what callers legitimately do', () => {
    const forbidden = [
      'export async function verifyRun(input) {',
      'const verifyRun = async (input) => {};',
      'export class PolicyStore {',
      'export function validatePolicy(raw) {',
      'function isReservedPolicyId(id) {',
      "export const GLOBAL_POLICY_ID = '__global__';",
      'export function createGatekeeperEgress(opts) {',
      'export function createGatekeeperIngress(opts: {',
      'const claims = await state.runTokens.verify(bearerOf(req));',
      'const claims = await this.runTokens.verify(params.runToken);',
    ];
    for (const line of forbidden) assert.equal(matches(line, SECOND_COPY).length >= 1, true, `should flag: ${line}`);

    const allowed = [
      "import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';",
      'const verdict = await verifyRun({ tokens: state.runTokens, token, runOf, ended });',
      "import { PolicyStore, validatePolicy } from '@beercanlabs/factory-gatekeeper/policy';",
      'const policies = new PolicyStore(dir);',
      'if (isReservedPolicyId(id)) continue;',
      'runTokens: new RunTokens(process.env.FACTORY_RUN_TOKEN_KEY),',
      'const token = await state.runTokens.mint({ runId, agentId });',
      'const claims = await tokens.verify(token);',
    ];
    for (const line of allowed) assert.deepEqual(matches(line, SECOND_COPY), [], `should allow: ${line}`);

    const reaches = (line: string) => [...line.matchAll(FORBIDDEN_IMPORTS)].length;
    assert.equal(reaches("import { createFactoryServer } from '@beercanlabs/factory-control-plane';"), 1);
    assert.equal(reaches("const e = await import('@beercanlabs/factory-property-manager');"), 1);
    assert.equal(reaches("import { createTimekeeper } from '@beercanlabs/factory-timekeeper';"), 1);
    assert.equal(reaches("import { checkStanding } from '@beercanlabs/factory-budget';"), 0, 'the Gatekeeper asks the Accountant');
    assert.equal(reaches("import { stripSignInLinksFromJson } from '@beercanlabs/factory-keymaster';"), 0, 'the Gatekeeper asks the Keymaster');

    const toGatekeeper = (line: string) => [...line.matchAll(IMPORTS_GATEKEEPER)].length;
    assert.equal(toGatekeeper("import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';"), 1);
    assert.equal(toGatekeeper("import { createGatekeeperEgress } from '@beercanlabs/factory-gatekeeper';"), 1);
    assert.equal(toGatekeeper("import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';"), 1);
    assert.equal(toGatekeeper("import { stripSignInLinksFromJson } from '@beercanlabs/factory-keymaster';"), 0);
  });

  it('no package outside the Gatekeeper defines its rules or verifies a run token by hand', () => {
    const found = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p) && NOT_GATEKEEPER(p) && !RUN_TOKEN_EXCEPTIONS.includes(p)).flatMap((f) =>
      matches(read(f), SECOND_COPY).map((m) => `${f}:${m}`),
    );
    assert.deepEqual(found, [], 'use the Gatekeeper through its entry points (@beercanlabs/factory-gatekeeper, /policy, /run-token), do not write the rule again');
  });

  it('the Gatekeeper imports no caller and no member above the perimeter (one-way dependency)', () => {
    const found = gatekeeperSource().flatMap((f) =>
      [...read(f).matchAll(FORBIDDEN_IMPORTS)].map((m) => `${f}:${lineOf(read(f), m.index ?? 0)}: ${m[0]}`),
    );
    assert.deepEqual(found, [], 'the control plane depends on the Gatekeeper, never the reverse; take what you need as a callback or a structural type');
  });

  it("the Gatekeeper's package.json lists none of those packages either", () => {
    const listed = manifestDeps('gatekeeper').filter((d) => /^@beercanlabs\/factory-(?:control-plane|console|property-manager|timekeeper|bench)$/.test(d));
    assert.deepEqual(listed, []);
  });

  it('the packages below the Gatekeeper never import it back, in source or manifest', () => {
    const found = BELOW_THE_GATEKEEPER.flatMap((pkg) => [
      ...files(`packages/${pkg}/src`, (p) => ANY_PACKAGE_SOURCE.test(p)).flatMap((f) =>
        [...read(f).matchAll(IMPORTS_GATEKEEPER)].map((m) => `${f}:${lineOf(read(f), m.index ?? 0)}: ${m[0]}`),
      ),
      ...manifestDeps(pkg).filter((d) => d === '@beercanlabs/factory-gatekeeper').map((d) => `packages/${pkg}/package.json: ${d}`),
    ]);
    assert.deepEqual(found, [], 'the Gatekeeper depends on these packages; the reverse is a cycle');
  });

  it("the Gatekeeper's entry points are the root plus the two listed subpaths, nothing deeper (D1)", () => {
    const manifest = JSON.parse(read('packages/gatekeeper/package.json')) as { exports?: Record<string, unknown> };
    assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), ['.', './policy', './run-token']);
  });
});
