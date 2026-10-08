import type { AgentRecord } from './catalog.js';
import { FULL_SHA, checkRepoUrl } from './source.js';

/**
 * Admission (DESIGN_AUTHORITY.md §6.8 L3, L4): only a pinned, admitted commit deploys, as an image tagged by its SHA.
 * The Registrar decides what is pinned and what the outcome of an admission is; it never builds an image, starts a run
 * or answers an HTTP request. The image build is the Landlord's and arrives as a callback, so `admit` can be called by
 * anything that has a source to admit (a deploy today; an admin admitting a newly seen commit later, L5).
 */

/** A pinned source: a git repository at one exact commit. Never a branch or "latest". */
export type AdmissionSource = { repo: string; commit: string };

/** The admission record kept on the agent. */
export type Admission = NonNullable<AgentRecord['admission']>;

/** What a caller may ask to re-pin; anything not given keeps the agent's registered value. */
export type PinRequest = { repo?: unknown; commit?: unknown };

export type PinResult =
  | { ok: true; source: AdmissionSource }
  | { ok: false; error: 'invalid_repo' | 'invalid_commit' | 'commit_required'; message: string };

/**
 * L3/L4: the source an admission would build, from the agent's registered pin and an optional re-pin. A request may
 * re-pin the repository and the commit; both must be well formed. A record without a pinned source is refused rather
 * than built from a mutable ref.
 */
export function pinSource(agent: Pick<AgentRecord, 'repo' | 'commit'>, request: PinRequest = {}): PinResult {
  const repo = request.repo !== undefined ? checkRepoUrl(request.repo) : agent.repo;
  if (request.repo !== undefined && !repo) {
    return { ok: false, error: 'invalid_repo', message: 'repo must be an https git URL without embedded credentials' };
  }
  const commit = request.commit !== undefined ? request.commit : agent.commit;
  if (request.commit !== undefined && (typeof commit !== 'string' || !FULL_SHA.test(commit))) {
    return { ok: false, error: 'invalid_commit', message: 'commit must be a full 40-character lowercase git SHA' };
  }
  if (!repo || typeof commit !== 'string' || !FULL_SHA.test(commit)) {
    return {
      ok: false,
      error: 'commit_required',
      message: 'Register the agent with "repo" (and optionally "commit") before deploying; the factory deploys only a pinned, admitted commit',
    };
  }
  return { ok: true, source: { repo, commit } };
}

/** The record of an admission that has started and not ended. */
export function beginAdmission(commit: string, now: Date = new Date()): Admission {
  return { commit, status: 'building', at: now.toISOString() };
}

export type AdmissionOutcome =
  | { status: 'admitted'; commit: string; imageUri: string }
  | { status: 'refused'; commit: string; reason: string; phase?: string; message: string };

export type AdmitOptions = {
  /** The Landlord's image build for the pinned source. Returns the SHA-tagged image; throws when the commit cannot be built. */
  build: (source: AdmissionSource) => Promise<string>;
  /**
   * Whether a thrown error is a refusal that names its reason. The guard promises the error carries `reason` (a string
   * the record keeps) and, optionally, `phase`; the control plane passes `err instanceof AdmissionRefusedError` (the
   * Landlord's class, which the Registrar does not import). Without it, or for any other error, the reason is
   * `build_failed`.
   */
  isRefusal?: (err: unknown) => err is { reason: string; phase?: string };
  /** Removes secret values from a message before it is kept (S1). */
  redact?: (message: string) => string;
};

/** Builds the pinned source and says whether it is admitted. It does not change any record and does not deploy. */
export async function admit(source: AdmissionSource, options: AdmitOptions): Promise<AdmissionOutcome> {
  try {
    const imageUri = await options.build(source);
    return { status: 'admitted', commit: source.commit, imageUri };
  } catch (err) {
    const refusal = options.isRefusal?.(err) ? (err as { reason: string; phase?: string }) : undefined;
    const raw = err instanceof Error ? err.message : String(err);
    return {
      status: 'refused',
      commit: source.commit,
      reason: refusal ? refusal.reason : 'build_failed',
      phase: refusal ? refusal.phase : undefined,
      message: options.redact ? options.redact(raw) : raw,
    };
  }
}

/** The admission record for an outcome. */
export function admissionOf(outcome: AdmissionOutcome, now: Date = new Date()): Admission {
  const at = now.toISOString();
  if (outcome.status === 'admitted') return { commit: outcome.commit, status: 'admitted', at };
  return { commit: outcome.commit, status: 'refused', reason: outcome.reason, phase: outcome.phase, message: outcome.message, at };
}

/**
 * Where an agent goes back to when its new commit is refused: a refused new version leaves the running version in
 * place. An agent that was never deployed has nothing to go back to and is in error.
 */
export function stateAfterRefusal(
  agent: Pick<AgentRecord, 'deployedCommit'>,
  previousState: AgentRecord['state'],
): AgentRecord['state'] {
  return agent.deployedCommit ? (previousState === 'ERROR' ? 'SLEEPING' : previousState) : 'ERROR';
}
