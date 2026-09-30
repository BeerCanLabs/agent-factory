// DESIGN_AUTHORITY.md §6.3 (P2): the Gatekeeper is the only name for the factory's perimeter.
import { describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot } from './support.js';

// The superseded names, spelled in pieces so this file does not match itself.
const OLD = new RegExp([['gate', 'way'].join(''), ['door', 'man'].join('')].join('|'), 'i');

// Third-party proper names are not the factory's (P2): Discord's gateway, cloud network gateways, HTTP status text.
const THIRD_PARTY = new RegExp(
  [
    'GatewayIntentBits', 'aws_internet_gateway', 'internet_gateway\\w*', 'nat_gateway\\w*', '\\bgateway_id\\b',
    '(?:internet|NAT) gateways?', 'Discord(?:\'s)? Gateway', 'Discord gateway', 'gateway\\.discord\\.gg', 'Bad Gateway',
    'payment-gateway', 'API Gateways?', 'vpc_endpoint_type\\s*=\\s*"Gateway"', 'gateway endpoints?',
  ].join('|'),
  'gi',
);

const SELF = 'packages/conformance/src/perimeter.test.ts';
const SKIP_DIRS =new Set(['.git', 'node_modules', 'dist', '.terraform']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|tf|tfvars|sh|py|toml|env|example|txt|html|css|hcl)$|(^|\/)(Dockerfile|Makefile|\.env[\w.]*)$/;

function repoFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(abs, name);
      const rel = relative(repoRoot, p);
      if (statSync(p).isDirectory()) walk(p);
      else if (TEXT.test(rel)) out.push(rel);
    }
  };
  walk(repoRoot);
  return out;
}

/** §7 of the Design Authority is append-only history (P2): it keeps the names it recorded. */
const current = (rel: string, text: string) => (rel === 'DESIGN_AUTHORITY.md' ? text.split('\n## 7.')[0] : text);

describe('P2 one name for the perimeter', () => {
  it('no file or path in the repository uses a superseded perimeter name', () => {
    const found: string[] = [];
    for (const rel of repoFiles()) {
      if (OLD.test(rel)) found.push(`${rel} (path)`);
      if (rel === SELF) continue; // its third-party list is the exemption itself
      current(rel, readFileSync(join(repoRoot, rel), 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (OLD.test(line.replace(THIRD_PARTY, ''))) found.push(`${rel}:${i + 1}`);
        });
    }
    assert.deepEqual(found, [], 'the perimeter is the Gatekeeper: gatekeeper-ingress and gatekeeper-egress (DESIGN_AUTHORITY.md P2)');
  });
});
