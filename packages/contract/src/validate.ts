import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  REQUIRED_FILES,
  artifactSchema,
  identitySchema,
  memorySchema,
  secretsManifestSchema,
  skillsSchema,
  surfaceSchema,
} from './schema.js';

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  cartridgeId: string;
  issues: ValidationIssue[];
};

const FORBIDDEN_VALUE_KEYS = new Set(['value', 'secret', 'password', 'token', 'key', 'plaintext']);

function issue(issues: ValidationIssue[], path: string, message: string) {
  issues.push({ path, message });
}

function readUtf8(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function parseYamlFile(filePath: string, issues: ValidationIssue[]): unknown {
  try {
    return parseYaml(readUtf8(filePath));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    issue(issues, filePath, `invalid YAML: ${message}`);
    return undefined;
  }
}

function assertNoSecretValues(node: unknown, filePath: string, issues: ValidationIssue[], jsonPath = '$'): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertNoSecretValues(child, filePath, issues, `${jsonPath}[${i}]`));
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_VALUE_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v.length > 0) {
      issue(issues, filePath, `plaintext secret field "${k}" at ${jsonPath} — cartridges declare names only`);
    }
    assertNoSecretValues(v, filePath, issues, `${jsonPath}.${k}`);
  }
}

function zodIssues(prefix: string, err: { issues: { path: (string | number)[]; message: string }[] }, issues: ValidationIssue[]) {
  for (const item of err.issues) {
    const loc = item.path.length ? item.path.join('.') : '(root)';
    issue(issues, prefix, `${loc}: ${item.message}`);
  }
}

export function validateCartridge(dir: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const cartridgeId = basename(dir);

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { ok: false, cartridgeId, issues: [{ path: dir, message: 'not a directory' }] };
  }

  const entries = new Set(readdirSync(dir));

  if (entries.has('.env') || entries.has('.env.local')) {
    issue(issues, join(dir, '.env'), 'env files are forbidden in a cartridge; use secrets.manifest.yaml');
  }

  for (const name of REQUIRED_FILES) {
    if (!entries.has(name)) {
      issue(issues, join(dir, name), 'required cartridge file is missing');
    }
  }

  const soulPath = join(dir, 'soul.md');
  if (entries.has('soul.md')) {
    const soul = readUtf8(soulPath).trim();
    if (!soul) issue(issues, soulPath, 'soul.md is empty');
  }

  if (entries.has('surface.yaml')) {
    const raw = parseYamlFile(join(dir, 'surface.yaml'), issues);
    if (raw !== undefined) {
      const parsed = surfaceSchema.safeParse(raw);
      if (!parsed.success) zodIssues(join(dir, 'surface.yaml'), parsed.error, issues);
    }
  }

  if (entries.has('secrets.manifest.yaml')) {
    const filePath = join(dir, 'secrets.manifest.yaml');
    const raw = parseYamlFile(filePath, issues);
    if (raw !== undefined) {
      assertNoSecretValues(raw, filePath, issues);
      const parsed = secretsManifestSchema.safeParse(raw);
      if (!parsed.success) zodIssues(filePath, parsed.error, issues);
    }
  }

  if (entries.has('artifact.yaml')) {
    const filePath = join(dir, 'artifact.yaml');
    const raw = parseYamlFile(filePath, issues);
    if (raw !== undefined) {
      const parsed = artifactSchema.safeParse(raw);
      if (!parsed.success) zodIssues(filePath, parsed.error, issues);
    }
  }

  if (entries.has('skills.yaml')) {
    const filePath = join(dir, 'skills.yaml');
    const raw = parseYamlFile(filePath, issues);
    if (raw !== undefined) {
      assertNoSecretValues(raw, filePath, issues);
      const parsed = skillsSchema.safeParse(raw);
      if (!parsed.success) zodIssues(filePath, parsed.error, issues);
    }
  }

  if (entries.has('identity.yaml')) {
    const filePath = join(dir, 'identity.yaml');
    const raw = parseYamlFile(filePath, issues);
    if (raw !== undefined) {
      const parsed = identitySchema.safeParse(raw);
      if (!parsed.success) zodIssues(filePath, parsed.error, issues);
    }
  }

  if (entries.has('memory.yaml')) {
    const filePath = join(dir, 'memory.yaml');
    const raw = parseYamlFile(filePath, issues);
    if (raw !== undefined) {
      const parsed = memorySchema.safeParse(raw);
      if (!parsed.success) zodIssues(filePath, parsed.error, issues);
    }
  }

  return { ok: issues.length === 0, cartridgeId, issues };
}
