#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { validateCartridge } from './validate.js';

function printHelp(): void {
  console.log(`factory — Agent Factory cartridge CLI

Usage:
  factory validate <dir> [<dir>...]
  factory validate --all <agents-root>

Exit 1 if any cartridge is invalid.
`);
}

function isCartridgeDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && readdirSync(dir).includes('soul.md');
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

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    printHelp();
    return cmd ? 0 : 1;
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

process.exit(main(process.argv.slice(2)));
