#!/usr/bin/env node
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateCartridge } from './validate.js';
import { packSkillDirectory, validateSkillPackage } from './package.js';

function printHelp(): void {
  console.log(`factory — Agent Factory CLI

Usage:
  factory validate <dir> [<dir>...]
  factory validate --all <agents-root>
  factory skill pack <dir> [--out <file>]
  factory skill register <dir> [--endpoint <url>] [--token <token>]

Commands:
  validate          Validate cartridge declarations
  skill pack        Pack a skill directory into a conforming .tar.gz package (A1, A6)
  skill register    Pack and upload a skill package to the registry (A5, A6)
`);
}

function isCartridgeDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
    const entries = readdirSync(dir);
    return entries.includes('cartridge.yaml') || entries.includes('soul.md');
  } catch {
    return false;
  }
}

function walkCartridges(root: string, depth = 0): string[] {
  if (!existsSync(root)) {
    throw new Error(`path not found: ${root}`);
  }
  if (isCartridgeDir(root)) return [root];
  if (depth > 3 || !statSync(root).isDirectory()) return [];
  return readdirSync(root).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const child = join(root, name);
    try {
      return statSync(child).isDirectory() ? walkCartridges(child, depth + 1) : [];
    } catch {
      return [];
    }
  });
}

function collectDirs(args: string[]): string[] {
  if (args[0] === '--all') {
    return walkCartridges(resolve(args[1] ?? 'agents'));
  }
  return args.map((p) => resolve(p));
}

async function handleSkill(args: string[]): Promise<number> {
  const [subcmd, dirArg, ...rest] = args;
  if (!subcmd || !dirArg || subcmd === '-h' || subcmd === '--help') {
    printHelp();
    return subcmd ? 0 : 1;
  }

  const dir = resolve(dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`directory not found: ${dir}`);
    return 1;
  }

  let outFile: string | undefined;
  let endpoint = process.env.FACTORY_URL || 'http://localhost:8088';
  let token = process.env.FACTORY_TOKEN || '';

  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--out' && rest[i + 1]) {
      outFile = resolve(rest[++i]);
    } else if (rest[i] === '--endpoint' && rest[i + 1]) {
      endpoint = rest[++i];
    } else if (rest[i] === '--token' && rest[i + 1]) {
      token = rest[++i];
    }
  }

  try {
    const pkgBuffer = await packSkillDirectory(dir);
    const validation = validateSkillPackage(pkgBuffer);
    if (!validation.ok) {
      console.error(`FAIL  skill package validation failed for ${dir}:`);
      for (const issue of validation.issues) {
        console.error(`  - ${issue}`);
      }
      return 1;
    }

    const { manifest, sha256 } = validation;
    const defaultName = `${manifest.id}-${manifest.version}.tar.gz`;
    const targetOut = outFile || resolve(defaultName);

    if (subcmd === 'pack') {
      writeFileSync(targetOut, pkgBuffer);
      console.log(`ok  packed ${manifest.id}@${manifest.version} (${pkgBuffer.length} bytes) -> ${targetOut}`);
      console.log(`    sha256: ${sha256}`);
      return 0;
    }

    if (subcmd === 'register') {
      const url = `${endpoint.replace(/\/+$/, '')}/api/v1/registry/skills`;
      console.log(`registering ${manifest.id}@${manifest.version} (${pkgBuffer.length} bytes, sha256: ${sha256.slice(0, 12)}) at ${url}...`);

      const headers: Record<string, string> = {
        'content-type': 'application/gzip',
      };
      if (token) {
        headers['authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: new Uint8Array(pkgBuffer),
      });

      const bodyText = await res.text();
      let resJson: Record<string, unknown> | null = null;
      try {
        resJson = JSON.parse(bodyText);
      } catch {
        // not json
      }

      if (res.status === 201) {
        console.log(`ok  registered ${manifest.id}@${manifest.version} (HTTP 201)`);
        if (resJson) {
          console.log(`    tests: ${resJson.tests}, status: ${resJson.status}`);
        }
        return 0;
      } else {
        console.error(`FAIL  registration failed (HTTP ${res.status}): ${bodyText}`);
        return 1;
      }
    }

    console.error(`unknown skill command: ${subcmd}`);
    printHelp();
    return 1;
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    return cmd ? 0 : 1;
  }

  if (cmd === 'skill') {
    return handleSkill(rest);
  }

  if (cmd !== 'validate') {
    console.error(`unknown command: ${cmd}`);
    printHelp();
    return 1;
  }
  if (rest.length === 0) {
    printHelp();
    return 1;
  }

  const dirs = collectDirs(rest);
  if (dirs.length === 0) {
    console.error('no cartridge directories found');
    return 1;
  }

  let failed = 0;
  for (const dir of dirs) {
    const result = validateCartridge(dir);
    if (result.ok) {
      console.log(`ok  ${result.cartridgeId}  ${dir}`);
      continue;
    }
    failed += 1;
    console.error(`FAIL  ${result.cartridgeId}  ${dir}`);
    for (const item of result.issues) {
      console.error(`  - ${item.path}: ${item.message}`);
    }
  }

  return failed === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
