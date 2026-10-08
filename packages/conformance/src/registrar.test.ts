// DESIGN_AUTHORITY.md §6.15 (Registrar), GAP-098: the agent record and registry store, source pinning, the skill registry,
// the configuration store and the admission decision exist once, in packages/registrar, and the dependency points one
// way: the control plane, the Landlord and the Keymaster depend on the Registrar.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './support.js';

// What this guard does not do, so the next reader does not mistake it for more:
//  - It is line-based and keys on the literal names `registryDir` and `REGISTRY_DIR`. A write through an alias
//    (`const dir = state.registryDir; writeFileSync(join(dir, ...))`) passes. `join(state.registryDir` catches the common
//    form, and the store being the only code that needs the path is what keeps it rare.
//  - It bans `status: 'building' | 'admitted' | 'refused'` as an object property in all of control-plane,
//    gatekeeper-egress and gatekeeper-ingress source, because nothing else uses those words today. A future unrelated
//    feature that needs one as a status of its own should narrow the pattern (to the admission record's other keys),
//    not delete the check.
//  - A `class SystemsStore` is forbidden unless it `extends` something: the control plane's subclass of the Registrar's store
//    (it adds the two Keymaster-derived methods) is the intended one, a standalone copy is not.
//  - It does NOT guard `invalid_repo` or `invalid_commit`, on purpose (GAP-101). The registration route legitimately
//    uses the same codes for its own checks, so no pattern separates the deploy rule's from registration's. Do not add
//    them back without first moving registration onto the Registrar's contract. `commit_required` is deploy-only, so it
//    is guarded.

const FS_WRITE = '(?:writeFileSync|unlinkSync|rmSync|renameSync|copyFileSync)';
const REGISTRY_DIR = '(?:registryDir|REGISTRY_DIR)';

/**
 * A second copy of the Registrar's rule. Each pattern is a definition or a write, never a use: importing the rule,
 * calling it and comparing an outcome's `status` are the point.
 */
const SECOND_COPY: Array<{ what: string; re: RegExp }> = [
  {
    what: 'a rule function or constant the Registrar owns, defined again',
    re: /\b(?:function|const|let|var)\s+(?:FULL_SHA|pinSource|admit|admissionOf|beginAdmission|stateAfterRefusal|compareSemver|checkSkillPath|fetchManifest|configHash|canonicalJson|archiveStamp|checkRepoUrl)\b/,
  },
  {
    what: 'a record or store type the Registrar owns, defined again',
    re: /\b(?:interface|class)\s+(?:AgentRecord|AgentRegistry|ConfigStore|SkillSource|SkillRegistry|VersionedConfigStore)\b|\bclass\s+SystemsStore\b(?!\s+extends\b)|\btype\s+(?:AgentRecord|ConfigStore|SkillSource)\s*(?:<[^>]*>)?\s*=/,
  },
  { what: 'a path built inside the registry directory', re: new RegExp(`\\bjoin\\(\\s*(?:state\\.)?${REGISTRY_DIR}\\b`) },
  { what: 'a write or delete on the registry directory', re: new RegExp(`\\b${FS_WRITE}\\b[^\\n]*\\b${REGISTRY_DIR}\\b|\\b${REGISTRY_DIR}\\b[^\\n]*\\b${FS_WRITE}\\b`) },
  { what: 'an admission record built by hand', re: /\bstatus:\s*'(?:building|admitted|refused)'/ },
  { what: 'the pin rule\'s commit_required error produced again', re: /\berror:\s*'commit_required'/ },
];

const matches = (src: string) =>
  src.split('\n').flatMap((line, i) => SECOND_COPY.filter((c) => c.re.test(line)).map((c) => `${i + 1}: ${line.trim()}  [${c.what}]`));

/** Where the rule used to live and could be copied back: the other kernel packages' own source. */
const GUARDED = /^packages\/(control-plane|gatekeeper-egress|gatekeeper-ingress)\/src\/.*\.ts$/;

describe('Registrar: one copy of the admission, pinning, record and configuration rules', () => {
  it('the patterns recognize what they exist to forbid, and not what callers legitimately do', () => {
    const forbidden = [
      'export const FULL_SHA = /^[0-9a-f]{40}$/;',
      'function pinSource(agent, body) {',
      'const compareSemver = (a: string, b: string) => 0;',
      'export function archiveStamp(now = new Date()): string {',
      'export class AgentRegistry {',
      'export type AgentRecord = {',
      'interface SkillSource {',
      'export class SystemsStore {',
      'type ConfigStore<T> = {',
      "writeFileSync(join(state.registryDir, `${agent.id}.json`), JSON.stringify(agent), 'utf8');",
      'const filePath = join(state.registryDir, `${id}.json`);',
      'unlinkSync(join(REGISTRY_DIR, name));',
      "agent.admission = { commit, status: 'building', at: now };",
      "json(res, 409, { error: 'commit_required', message });",
    ];
    for (const line of forbidden) assert.equal(matches(line).length >= 1, true, `should be caught: ${line}`);

    const allowed = [
      "import { BUILTIN_AGENT_IDS, declaredCredentials, type AgentRecord } from '@beercanlabs/factory-registrar';",
      '  type SkillSource,',
      '  type ConfigStore,',
      'export class SystemsStore extends RegistrarSystemsStore {',
      'const pin = pinSource(agent, body);',
      "if (outcome.status === 'refused') {",
      "json(res, pin.error === 'commit_required' ? 409 : 400, { error: pin.error, message: pin.message });",
      'registryDir?: string;',
      '  registryDir: REGISTRY_DIR,',
      'return new AgentRegistry(state.registryDir, (message, err) => console.warn(message, err));',
      'const dynamicAgents = loadDynamicRegistry(REGISTRY_DIR);',
      'mkdirSync(REGISTRY_DIR, { recursive: true });',
      "json(res, 400, { error: 'invalid_commit', message: 'commit must be a full 40-character lowercase git SHA' });",
    ];
    for (const line of allowed) assert.deepEqual(matches(line), [], `should be allowed: ${line}`);
  });

  it('the patterns see the real originals in packages/registrar, so they are not vacuous', () => {
    const originals: Array<[string, string]> = [
      ['packages/registrar/src/source.ts', 'FULL_SHA'],
      ['packages/registrar/src/admission.ts', 'pinSource'],
      ['packages/registrar/src/catalog.ts', 'AgentRecord'],
      ['packages/registrar/src/registry.ts', 'AgentRegistry'],
      ['packages/registrar/src/skills.ts', 'compareSemver'],
      ['packages/registrar/src/config-store.ts', 'archiveStamp'],
      ['packages/registrar/src/systems.ts', 'SystemsStore'],
    ];
    for (const [file, name] of originals) {
      assert.ok(matches(read(file)).some((m) => m.includes(name)), `${file} no longer defines ${name} where the guard looks for it`);
    }
  });

  it('control-plane, gatekeeper-egress and gatekeeper-ingress source do not define the Registrar\'s rules or write its registry again', () => {
    const found = files('packages', (p) => GUARDED.test(p) && !p.endsWith('.test.ts')).flatMap((f) => matches(read(f)).map((m) => `${f}:${m}`));
    assert.deepEqual(found, [], 'the agent record, source pinning, skill registry, configuration store and admission decision are the Registrar\'s: import them from @beercanlabs/factory-registrar');
  });

  it('packages/registrar depends on no control-plane, gatekeeper or console package, in its manifest or its source', () => {
    const pkg = JSON.parse(read('packages/registrar/package.json')) as Record<string, Record<string, string> | undefined>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}));
    const back = names.filter((n) => /^@beercanlabs\/factory-(control-plane|gatekeeper-.+|console)$/.test(n));
    assert.deepEqual(back, [], 'the dependency points one way: the control plane depends on the Registrar');

    const IMPORT_BACK = /\bfrom\s+['"](?:@beercanlabs\/factory-(?:control-plane|gatekeeper-[a-z-]+|console)|(?:\.\.\/)+(?:control-plane|gatekeeper-[a-z-]+|console))\b/;
    assert.equal(IMPORT_BACK.test("import { x } from '@beercanlabs/factory-control-plane';"), true);
    const upToControlPlane = ['..', '..', 'control-plane', 'src', 'app.js'].join('/'); // built, so this file holds no relative cross-package import itself
    assert.equal(IMPORT_BACK.test(`import { x } from '${upToControlPlane}';`), true);
    assert.equal(IMPORT_BACK.test("import { x } from '@beercanlabs/factory-contract';"), false);
    assert.equal(IMPORT_BACK.test("import { x } from './source.js';"), false);
    const imports = files('packages/registrar/src', (p) => p.endsWith('.ts') && !p.endsWith('.test.ts')).flatMap((f) =>
      read(f).split('\n').filter((l) => IMPORT_BACK.test(l)).map((l) => `${f}: ${l.trim()}`),
    );
    assert.deepEqual(imports, [], 'the Registrar takes what it needs from another member by a callback or a structural type, never by importing it');
  });
});
