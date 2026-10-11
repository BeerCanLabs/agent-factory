// DESIGN_AUTHORITY.md §6.15 (Landlord), GAP-132: the run lifecycle, the run store, the queue pollers, the runtime
// launchers, the callback delivery and the AWS and GCP build, IAM and deploy adapters exist once, in packages/landlord,
// and the dependency points one way: the control plane depends on the Landlord.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

// What this guard does and does not do, so the next reader does not mistake it for more:
//  - It reads TypeScript and JavaScript source (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) under every package's `src/` except
//    the Landlord's own. Build output, tests and root-level config files are not read.
//  - It matches text, not syntax. A definition is found where the layout is plain (`export async function` and the name
//    on the same line), but a rule copied under a different name passes, and so does a definition split over lines.
//  - It does NOT guard `record`, `startRun`, `fireCallback`, `bindAgentSecrets` or `notifyGatekeeperIngress`. They are
//    internal to the lifecycle (not exported from the package) and are ordinary words another member could use.
//  - It does NOT guard the HTTP handlers (`handleMcp`, the wake, run and kill-switch routes) or `unblockAffordableRuns`,
//    `handoffRefusal` and `enrichAgent`. They stay in `control-plane` (the Bouncer's privileges and the Gatekeeper's
//    run-token rule meet a request there; the budget and the console's view are the Treasurer's and the console's).
//  - It does NOT guard `FactoryState`. It stays in `app.ts` and is assignable to the Landlord's `LandlordState`.
//  - It does NOT guard the CodeBuild SDK as a whole: the Registrar's skill-check runner
//    (`control-plane/src/aws/skill-checker.ts`) and the Treasurer's `aws/treasurer.ts` use it (ECS, Cost Explorer, STS).

/** Names the Landlord owns. A definition of any of them outside the package is a second copy. */
const OWNED_VALUES = [
  // the run lifecycle
  'createRun', 'finishRun', 'blockRun', 'unblockRun', 'activeRun', 'scheduleTimeout', 'deliverToMailbox', 'markRunReady',
  'applyKillSwitch', 'haltUnhealthy', 'checkHealth', 'routeEvents', 'reconcileRuns', 'resetAgent',
  // the run store and the queue pollers
  'MemoryRunStore', 'FileRunStore', 'pollQueueOnce', 'startQueuePollers',
  // callbacks and the runtime launchers
  'checkCallbackUrl', 'deliverCallback', 'memoryRuntime', 'noopRuntime', 'dockerRuntime', 'ecsRuntime',
  // the build side the cloud adapters share
  'imageTagFor', 'skillsHash', 'AdmissionRefusedError', 'admissionFailure', 'buildAgentImage', 'awsDeployProvider', 'gcpDeployProvider',
  // the factory's own actors
  'SYSTEM',
].join('|');

/** The cloud SDKs only the Landlord's adapters use (IAM, Secrets Manager, Cloud Build, Cloud Run, their auth). */
const LANDLORD_SDKS = /['"](?:@aws-sdk\/client-iam|@aws-sdk\/client-secrets-manager|@google-cloud\/[a-z-]+|google-auth-library)['"]/g;

/** A second copy of the Landlord's code: a definition of a name it owns. Never a use. */
const SECOND_COPY: Array<{ what: string; re: RegExp }> = [
  { what: 'a function, constant or class the Landlord owns, defined again', re: new RegExp(`\\b(?:function|const|let|var|class)\\s+(?:${OWNED_VALUES})\\b`, 'gm') },
  { what: 'a cloud SDK only the Landlord uses, imported again', re: LANDLORD_SDKS },
];

/** Packages the Landlord must never import: the callers it serves, and the other members' perimeter code. */
const FORBIDDEN_IMPORTS =
  /['"]@beercanlabs\/factory-(?:control-plane|gatekeeper|console|executive|keymaster|timekeeper|bench)(?:\/[^'"]*)?['"]/g;

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;
const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ');
const matches = (src: string, patterns: Array<{ what: string; re: RegExp }>) =>
  patterns.flatMap((c) => [...src.matchAll(c.re)].map((m) => `${lineOf(src, m.index ?? 0)}: ${oneLine(m[0])}  [${c.what}]`));

const nonTestSource = (p: string) => !/\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(p);
const NOT_LANDLORD = (p: string) => !p.startsWith('packages/landlord/');
const ANY_PACKAGE_SOURCE = /^packages\/[^/]+\/src\/.*\.(?:ts|tsx|js|mjs|cjs)$/;
const landlordSource = () => files('packages/landlord/src', (p) => ANY_PACKAGE_SOURCE.test(p));

describe('Landlord: one copy of the compute lifecycle, and the dependency points one way', () => {
  it('the patterns recognize what they exist to forbid, and not what callers legitimately do', () => {
    const forbidden = [
      'export async function createRun(state, agentId, opts) {',
      'async function finishRun(state, runId, terminal, extra) {',
      'export function activeRun(state, agentId) {',
      'const scheduleTimeout = (state, run) => {};',
      'export class MemoryRunStore implements RunStore {',
      'class FileRunStore extends MemoryRunStore {',
      'export function noopRuntime() {',
      'function dockerRuntime(opts) {',
      'export const SYSTEM = { idle: "factory:run-timeout" } as const;',
      'export class AdmissionRefusedError extends Error {',
      "import { IAMClient } from '@aws-sdk/client-iam';",
      'import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";',
      "import { CloudBuildClient } from '@google-cloud/cloudbuild';",
      "import { JobsClient } from '@google-cloud/run';",
      "import { GoogleAuth } from 'google-auth-library';",
    ];
    for (const line of forbidden) assert.equal(matches(line, SECOND_COPY).length >= 1, true, `should flag: ${line}`);

    const allowed = [
      "import { createRun, finishRun, SYSTEM } from '@beercanlabs/factory-landlord';",
      'const res = await createRun(state, agentId, { actor: SYSTEM.scheduler, trigger: "cron" });',
      'const run = activeRun(state, agentId);',
      'new MemoryRunStore();',
      'const store = new FileRunStore(dir);',
      "const { awsDeployProvider } = await import('@beercanlabs/factory-landlord/aws/deploy');",
      "import { CodeBuildClient } from '@aws-sdk/client-codebuild';",
      "import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';",
      "import { ECSClient } from '@aws-sdk/client-ecs';",
    ];
    for (const line of allowed) assert.deepEqual(matches(line, SECOND_COPY), [], `should allow: ${line}`);

    const reaches = (line: string) => [...line.matchAll(FORBIDDEN_IMPORTS)].length;
    assert.equal(reaches("import { createFactoryServer } from '@beercanlabs/factory-control-plane';"), 1);
    assert.equal(reaches("const e = await import('@beercanlabs/factory-gatekeeper');"), 1);
    assert.equal(reaches("import { createTimekeeper } from '@beercanlabs/factory-timekeeper';"), 1);
    assert.equal(reaches("import { checkStanding } from '@beercanlabs/factory-budget';"), 0, 'the Landlord asks the Treasurer');
    assert.equal(reaches("import { AgentRegistry } from '@beercanlabs/factory-registrar';"), 0, 'the Landlord depends on the Registrar');
  });

  it('no package outside the Landlord defines its rules or imports the cloud SDKs only it uses', () => {
    const found = files('packages', (p) => ANY_PACKAGE_SOURCE.test(p) && nonTestSource(p) && NOT_LANDLORD(p)).flatMap((f) =>
      matches(read(f), SECOND_COPY).map((m) => `${f}:${m}`),
    );
    assert.deepEqual(found, [], 'use the Landlord through its entry point (@beercanlabs/factory-landlord), do not write the rule again');
  });

  it('the Landlord imports no caller and no other member perimeter package (one-way dependency)', () => {
    const found = landlordSource().flatMap((f) =>
      [...read(f).matchAll(FORBIDDEN_IMPORTS)].map((m) => `${f}:${lineOf(read(f), m.index ?? 0)}: ${m[0]}`),
    );
    assert.deepEqual(found, [], 'the control plane depends on the Landlord, never the reverse; take what you need as a callback or a structural type');
  });

  it("the Landlord's package.json lists none of those packages either", () => {
    const manifest = JSON.parse(read('packages/landlord/package.json')) as { dependencies?: Record<string, string> };
    const listed = Object.keys(manifest.dependencies ?? {}).filter((d) =>
      /^@beercanlabs\/factory-(?:control-plane|gatekeeper|console|executive|keymaster|timekeeper|bench)$/.test(d),
    );
    assert.deepEqual(listed, []);
  });

  it("the Landlord's entry point is the root plus the two cloud subpaths, nothing deeper (D1)", () => {
    const manifest = JSON.parse(read('packages/landlord/package.json')) as { exports?: Record<string, unknown> };
    assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), ['.', './aws/*', './gcp/*']);
  });
});
