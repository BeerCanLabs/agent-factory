import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packSkillDirectory, validateSkillPackage } from '@beercanlabs/factory-contract';
import type { FactoryClient } from './client.js';

export async function handleSkillPack(argv: string[], writeOut: (text: string) => Promise<void>): Promise<number> {
  const dir = argv[0];
  if (!dir) {
    throw new Error('usage: factory skill pack <dir> [--out <file>]');
  }

  let outFile: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      outFile = argv[i + 1];
      i++;
    }
  }

  const gz = await packSkillDirectory(resolve(dir));
  const checked = validateSkillPackage(gz);
  if (!checked.ok) {
    throw new Error(`cannot pack skill: ${checked.issues.join('; ')}`);
  }

  const destination = outFile ? resolve(outFile) : resolve(`${checked.manifest.id}-${checked.manifest.version}.tar.gz`);
  writeFileSync(destination, gz);
  await writeOut(`Packed skill ${checked.manifest.id}@${checked.manifest.version} (${gz.length} bytes, sha256: ${checked.sha256})\n -> ${destination}\n`);
  return 0;
}

export async function handleSkillRegister(
  client: FactoryClient,
  argv: string[],
  writeOut: (text: string) => Promise<void>,
  writeErr: (text: string) => Promise<void>,
): Promise<number> {
  const dir = argv[0];
  if (!dir) {
    throw new Error('usage: factory skill register <dir>');
  }

  const gz = await packSkillDirectory(resolve(dir));
  const checked = validateSkillPackage(gz);
  if (!checked.ok) {
    throw new Error(`cannot pack skill: ${checked.issues.join('; ')}`);
  }

  const res = await client.upload('/api/v1/registry/skills', gz, 'application/gzip');
  if (res.status === 201) {
    await writeOut(`Registered skill ${checked.manifest.id}@${checked.manifest.version} (sha256: ${checked.sha256.slice(0, 12)}). Checks started.\n`);
    return 0;
  }

  const body = res.body as { error?: string; reasons?: string[]; message?: string } | undefined;
  const msg = body?.reasons ? body.reasons.join('\n') : (body?.message || body?.error || `HTTP ${res.status}`);
  await writeErr(`Failed to register skill (${res.status}): ${msg}\n`);
  return 1;
}
