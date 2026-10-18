#!/usr/bin/env node
// Builds the kernel packages in dependency order, then every other workspace with a build script, each once (GAP-172).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ORDERED = [
  '@beercanlabs/factory-auth',
  '@beercanlabs/factory-contract',
  '@beercanlabs/factory-ledger',
  '@beercanlabs/factory-budget',
  '@beercanlabs/factory-executive',
  '@beercanlabs/factory-bouncer',
  '@beercanlabs/factory-timekeeper',
  '@beercanlabs/factory-registrar',
  '@beercanlabs/factory-secrets-bind',
  '@beercanlabs/factory-hydrate',
  '@beercanlabs/factory-keymaster',
  '@beercanlabs/factory-telemetry',
  '@beercanlabs/factory-inspector',
  '@beercanlabs/factory-property-manager',
  '@beercanlabs/factory-gatekeeper',
  '@beercanlabs/factory-bench',
];

const root = join(import.meta.dirname, '..');
const rest = readdirSync(join(root, 'packages'))
  .map((dir) => join(root, 'packages', dir, 'package.json'))
  .filter(existsSync)
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter((pkg) => pkg.scripts?.build && !ORDERED.includes(pkg.name))
  .map((pkg) => pkg.name);

const build = (names) => execFileSync('npm', ['run', 'build', ...names.flatMap((n) => ['-w', n])], { cwd: root, stdio: 'inherit' });
build(ORDERED);
if (rest.length > 0) build(rest);
