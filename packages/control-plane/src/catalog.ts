import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateCartridge, type Surface } from '@beercanlabs/factory-contract';

export type AgentRecord = {
  id: string;
  name: string;
  role: string;
  state: 'IDLE' | 'WORKING' | 'PAUSED' | 'ISOLATED' | 'BLOCKED_FOR_HUMAN' | 'ERROR';
  provider: string;
  artifact: string;
  localCommand?: string[];
  requires: string[];
  triggers: Surface['triggers'];
  memoryPrefix?: string;
  dir: string;
};

export function loadCatalog(agentsRoot: string): AgentRecord[] {
  const dirs = walk(agentsRoot);
  const out: AgentRecord[] = [];
  for (const dir of dirs) {
    const result = validateCartridge(dir);
    if (!result.ok) continue;
    const soul = readFileSync(join(dir, 'soul.md'), 'utf8');
    const name = titleFromSoul(soul) ?? result.cartridgeId;
    const role = mandateFromSoul(soul) ?? name;
    let artifact = '';
    let localCommand: string[] | undefined;
    try {
      const raw = parseYaml(readFileSync(join(dir, 'artifact.yaml'), 'utf8')) as {
        ref?: string;
        localCommand?: string[];
      };
      artifact = raw.ref ?? '';
      localCommand = raw.localCommand;
    } catch {
      artifact = '';
    }
    let requires: string[] = [];
    try {
      const raw = parseYaml(readFileSync(join(dir, 'secrets.manifest.yaml'), 'utf8')) as { requires?: string[] };
      requires = raw.requires ?? [];
    } catch {
      requires = [];
    }
    let triggers: Surface['triggers'] = [];
    try {
      const raw = parseYaml(readFileSync(join(dir, 'surface.yaml'), 'utf8')) as Surface;
      triggers = raw.triggers ?? [];
    } catch {
      triggers = [];
    }
    let memoryPrefix: string | undefined;
    try {
      const raw = parseYaml(readFileSync(join(dir, 'memory.yaml'), 'utf8')) as { prefix?: string };
      memoryPrefix = raw.prefix;
    } catch {
      memoryPrefix = result.cartridgeId;
    }
    out.push({
      id: result.cartridgeId,
      name,
      role,
      state: 'IDLE',
      provider: 'local',
      artifact,
      localCommand,
      requires,
      triggers,
      memoryPrefix,
      dir,
    });
  }
  return out;
}

function walk(root: string, depth = 0): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const here = entries.includes('soul.md') ? [root] : [];
  if (depth >= 3) return here;
  const nested = entries.flatMap((name) => {
    if (name.startsWith('.')) return [];
    const child = join(root, name);
    try {
      return statSync(child).isDirectory() && basename(child) !== 'node_modules' ? walk(child, depth + 1) : [];
    } catch {
      return [];
    }
  });
  return [...here, ...nested];
}

function titleFromSoul(soul: string): string | undefined {
  const m = soul.match(/^#\s+Soul:\s*(.+)$/m);
  return m?.[1]?.trim();
}

function mandateFromSoul(soul: string): string | undefined {
  const m = soul.match(/\*\*Mandate:\*\*\s*(.+)$/m);
  return m?.[1]?.trim();
}
