import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateCartridge, type Surface, type Cartridge } from '@beercanlabs/factory-contract';

export type AgentRecord = {
  id: string;
  name: string;
  role: string;
  state: 'SLEEPING' | 'WORKING' | 'PAUSED' | 'ISOLATED' | 'BLOCKED_FOR_HUMAN' | 'ERROR' | 'PENDING_BUDGET' | 'PENDING_DEPLOY' | 'DEPLOYING';
  provider: string;
  artifact: string;
  localCommand?: string[];
  requires: string[];
  triggers: Surface['triggers'];
  memoryPrefix?: string;
  warmDownSeconds?: number;
  dir: string;
};

export function loadCatalog(agentsRoot: string): AgentRecord[] {
  const dirs = walk(agentsRoot);
  const out: AgentRecord[] = [];
  for (const dir of dirs) {
    const result = validateCartridge(dir);
    if (!result.ok) continue;

    const entries = new Set(readdirSync(dir));
    let soulContent = '';
    if (entries.has('soul.md')) {
      try {
        soulContent = readFileSync(join(dir, 'soul.md'), 'utf8');
      } catch {}
    }

    let name = (soulContent ? titleFromSoul(soulContent) : undefined) ?? result.cartridgeId;
    let role = (soulContent ? mandateFromSoul(soulContent) : undefined) ?? name;
    let artifact = '';
    let localCommand: string[] | undefined;
    let requires: string[] = [];
    let triggers: Surface['triggers'] = [];
    let memoryPrefix: string | undefined = result.cartridgeId;
    let warmDownSeconds: number | undefined;

    // Check for unified cartridge.yaml first
    if (entries.has('cartridge.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'cartridge.yaml'), 'utf8')) as Cartridge;
        if (raw.name) name = raw.name;
        if (raw.role) role = raw.role;
        if (raw.compute?.ref || raw.artifact?.ref) {
          artifact = raw.compute?.ref || raw.artifact?.ref || '';
        }
        if (raw.compute?.localCommand || raw.artifact?.localCommand) {
          localCommand = raw.compute?.localCommand || raw.artifact?.localCommand;
        }
        if (raw.secrets?.requires) {
          requires = raw.secrets.requires.map((s) => (typeof s === 'string' ? s : s.name));
        }
        if (raw.triggers) {
          triggers = raw.triggers;
        }
        if (raw.persistence?.prefix || raw.memory?.prefix) {
          memoryPrefix = raw.persistence?.prefix || raw.memory?.prefix;
        }
        if (raw.runtime?.warmDownSeconds) {
          warmDownSeconds = Number(raw.runtime.warmDownSeconds);
        }
      } catch (err) {
        console.error(`[catalog] failed to parse cartridge.yaml in ${dir}:`, err);
      }
    }

    // Fall back to legacy individual files if not populated by cartridge.yaml
    if (!artifact && entries.has('artifact.yaml')) {
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
    }
    if (requires.length === 0 && entries.has('secrets.manifest.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'secrets.manifest.yaml'), 'utf8')) as { requires?: string[] };
        requires = raw.requires ?? [];
      } catch {
        requires = [];
      }
    }
    if (triggers.length === 0 && entries.has('surface.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'surface.yaml'), 'utf8')) as Surface;
        triggers = raw.triggers ?? [];
      } catch {
        triggers = [];
      }
    }
    if (memoryPrefix === result.cartridgeId && entries.has('memory.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'memory.yaml'), 'utf8')) as { prefix?: string };
        if (raw.prefix) memoryPrefix = raw.prefix;
      } catch {
        memoryPrefix = result.cartridgeId;
      }
    }

    out.push({
      id: result.cartridgeId,
      name,
      role,
      state: 'SLEEPING',
      provider: 'local',
      artifact,
      localCommand,
      requires,
      triggers,
      memoryPrefix,
      warmDownSeconds,
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
  const here = entries.includes('cartridge.yaml') || entries.includes('soul.md') ? [root] : [];
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

