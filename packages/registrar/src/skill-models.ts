/**
 * S24 (D31): factory-side per-skill model binding.
 *
 * A skill's model is a factory setting its `content-owner` (or an admin) picks from evals, never a field of the skill
 * manifest, so swapping it needs no new skill version and no redeploy. Every agent that runs the skill inherits the
 * binding for calls made on the skill's behalf; the agent's own model stays an ops/owner setting.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SkillModelBinding = {
  skillId: string;
  model: string;
  setBy: string;
  setAt: string;
};

type Doc = { bindings: SkillModelBinding[] };

type Warn = (message: string, err?: unknown) => void;

const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function isValidSkillModelName(model: unknown): model is string {
  return typeof model === 'string' && MODEL_NAME.test(model);
}

function isValidBinding(v: unknown): v is SkillModelBinding {
  if (!v || typeof v !== 'object') return false;
  const b = v as Record<string, unknown>;
  return (
    typeof b.skillId === 'string' &&
    SKILL_ID.test(b.skillId) &&
    isValidSkillModelName(b.model) &&
    typeof b.setBy === 'string' &&
    typeof b.setAt === 'string'
  );
}

/** File-backed (or in-memory when `filePath` is absent) store of skill → model bindings. Writes are atomic renames. */
export class SkillModelBindingStore {
  private readonly bindings = new Map<string, SkillModelBinding>();

  constructor(
    private readonly filePath?: string,
    warn: Warn = (message, err) => console.warn(`[registrar] ${message}`, err),
  ) {
    if (!filePath || !existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Doc>;
      for (const item of Array.isArray(raw?.bindings) ? raw.bindings : []) {
        if (isValidBinding(item)) this.bindings.set(item.skillId, { ...item });
        else warn(`skipping invalid skill model binding in ${filePath}`, item);
      }
    } catch (err) {
      warn(`skipping unreadable skill model bindings file ${filePath}:`, err);
    }
  }

  get(skillId: string): SkillModelBinding | undefined {
    const b = this.bindings.get(skillId.toLowerCase());
    return b ? { ...b } : undefined;
  }

  list(): SkillModelBinding[] {
    return [...this.bindings.values()].map((b) => ({ ...b }));
  }

  /** Binds (or swaps) `skillId` to `model`. Returns the new binding and the model it replaced, if any. */
  set(skillId: string, model: string, actor: string, now = new Date().toISOString()): { binding: SkillModelBinding; previous?: string } {
    const id = skillId.toLowerCase();
    if (!SKILL_ID.test(id)) throw new Error(`invalid skill id ${JSON.stringify(skillId)}`);
    if (!isValidSkillModelName(model)) throw new Error(`invalid model name ${JSON.stringify(model)}`);
    const previous = this.bindings.get(id)?.model;
    const binding: SkillModelBinding = { skillId: id, model, setBy: actor, setAt: now };
    const next = new Map(this.bindings);
    next.set(id, binding);
    this.persist(next);
    this.bindings.set(id, binding);
    return { binding: { ...binding }, ...(previous ? { previous } : {}) };
  }

  /** Removes a binding; calls on the skill's behalf then use the calling agent's own model. */
  clear(skillId: string): string | undefined {
    const id = skillId.toLowerCase();
    const previous = this.bindings.get(id)?.model;
    if (previous === undefined) return undefined;
    const next = new Map(this.bindings);
    next.delete(id);
    this.persist(next);
    this.bindings.delete(id);
    return previous;
  }

  private persist(next: Map<string, SkillModelBinding>): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const doc: Doc = { bindings: [...next.values()].sort((a, b) => a.skillId.localeCompare(b.skillId)) };
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
