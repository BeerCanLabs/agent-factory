import React, { useEffect, useState } from 'react';
import { AlertTriangle, Archive, Loader2, PauseCircle, RotateCcw, ShieldCheck, ShieldOff, UserMinus, XCircle } from 'lucide-react';
import type { SkillAdopter, SkillSummary, SkillVersion } from '../../api/types.js';
import { ApiError, factoryApi } from '../../api/client.js';
import { Dialog } from '../../components/Dialog.js';
import { Requirements } from './Requirements.js';
import { errorText, key, retireConfirmed, retireEffect, retireImpact, shortSha, sourceLinks } from './skills-model.js';
import { btnDanger, btnPrimary, btnQuiet, input, label } from './ui.js';

export type Decision = { kind: 'approve' | 'reject'; skill: SkillSummary; version: SkillVersion };

/**
 * Approve: an optional reason, then a confirmation. Reject or revoke: a reason. Revoking a version in use is refused
 * with the agents listed; "Revoke anyway" pauses them, behind a second confirmation that names them (SK1).
 */
export const DecisionDialog: React.FC<{ decision: Decision; onClose: () => void; onDone: (message: string) => void }> = ({ decision, onClose, onDone }) => {
  const { kind, skill, version: v } = decision;
  const revoke = kind === 'reject' && v.status === 'approved';
  const [step, setStep] = useState<'form' | 'confirm' | 'in_use' | 'force'>('form');
  const [reason, setReason] = useState('');
  const [agents, setAgents] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = `${v.id}@${v.version}`;

  const submit = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') {
        await factoryApi.approveSkill(v.id, v.version, reason.trim() || undefined);
        onDone(`Approved ${name}. Agent owners can now adopt it.`);
      } else {
        const res = await factoryApi.rejectSkill(v.id, v.version, reason.trim(), force);
        const paused = res.paused ?? [];
        const removed = res.removedFrom ?? [];
        onDone(
          revoke
            ? `Revoked ${name}.${paused.length ? ` Paused ${paused.join(', ')}.` : ''}${removed.length ? ` Removed it from ${removed.join(', ')} and rebuilding ${removed.length === 1 ? 'it' : 'them'} without it; each resumes when that finishes.` : ''}`
            : `Rejected ${name}.`,
        );
      }
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      if (err instanceof ApiError && err.status === 409 && body?.error === 'skill_in_use') {
        setAgents(Array.isArray(body.agents) ? body.agents.map(String) : []);
        setAcknowledged(false);
        setStep('in_use');
      } else if (body?.error === 'checks_failed') {
        setError(`The factory's checks failed: ${(body.failures ?? []).join('; ') || 'see the version'}.`);
      } else if (body?.error === 'checks_pending') {
        setError("The factory's checks have not passed yet; approval waits for them.");
      } else {
        setError(body?.message ? `${errorText(err)}: ${body.message}` : errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const pin = (
    <div className="font-mono text-[11px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 space-y-0.5">
      <div className="font-semibold text-slate-800 dark:text-slate-200">{name}</div>
      <div className="text-slate-500 break-all">
        {sourceLinks(v).repo} · {v.path} · {shortSha(v.commit)}
      </div>
    </div>
  );
  const errorBox = error && (
    <p className="text-[11px] text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded px-2 py-1.5">{error}</p>
  );
  const cancel = (
    <button className={btnQuiet} onClick={onClose} disabled={busy}>
      Cancel
    </button>
  );
  const spinner = busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null;

  if (kind === 'approve') {
    return (
      <Dialog
        title={step === 'form' ? `Approve ${skill.name} ${v.version}` : 'Confirm approval'}
        onClose={onClose}
        busy={busy}
        footer={
          step === 'form' ? (
            <>
              {cancel}
              <button className={btnPrimary} onClick={() => setStep('confirm')}>
                Continue
              </button>
            </>
          ) : (
            <>
              <button className={btnQuiet} onClick={() => setStep('form')} disabled={busy}>
                Back
              </button>
              <button className={btnPrimary} data-autofocus onClick={() => submit()} disabled={busy}>
                {spinner}
                <ShieldCheck className="w-3.5 h-3.5" />
                Approve {v.version}
              </button>
            </>
          )
        }
      >
        {pin}
        {step === 'form' ? (
          <>
            <p>
              The factory's checks on this commit passed.{' '}
              {skill.visibility === 'private' && skill.owner
                ? `This skill is private to ${skill.owner}: approving adopts it for ${skill.owner} in the same step (unless its adoption was removed), and that agent is rebuilt with it.`
                : 'Approving makes this version available. It adopts nothing: each agent’s adoption is approved separately, and always within that agent’s policy.'}
            </p>
            <Requirements requires={v.manifest?.requires} />
            <label className="block space-y-1">
              <span className={label}>Reason (optional)</span>
              <textarea className={`${input} h-20`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="e.g. reviewed at the pinned commit" />
            </label>
          </>
        ) : (
          <>
            <p>
              Approve <strong className="font-mono">{name}</strong> at commit <span className="font-mono">{shortSha(v.commit)}</span>?
            </p>
            {reason.trim() && <p className="text-slate-500">Reason: {reason.trim()}</p>}
            <p className="text-slate-500">The approval is recorded in the ledger under your name.</p>
          </>
        )}
        {errorBox}
      </Dialog>
    );
  }

  const verb = revoke ? 'Revoke' : 'Reject';
  if (step === 'form') {
    return (
      <Dialog
        title={`${verb} ${skill.name} ${v.version}`}
        tone="danger"
        onClose={onClose}
        busy={busy}
        footer={
          <>
            {cancel}
            <button className={btnDanger} onClick={() => submit()} disabled={busy || !reason.trim()}>
              {spinner}
              {revoke ? <ShieldOff className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
              {verb} {v.version}
            </button>
          </>
        }
      >
        {pin}
        <p>
          {revoke
            ? 'Revoking an approved version stops any agent from adopting it. If an agent uses it, the factory refuses until that agent is redeployed without it, and you will be shown which agents.'
            : 'A rejected version can never be adopted. Register a new version to try again.'}
        </p>
        <label className="block space-y-1">
          <span className={label}>Reason (required)</span>
          <textarea className={`${input} h-20`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="Why; the author sees this" />
        </label>
        {errorBox}
      </Dialog>
    );
  }

  const agentList = (
    <ul className="space-y-1">
      {agents.map((a) => (
        <li key={a} className="flex items-center gap-2 font-mono text-[11px] bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded px-2 py-1">
          <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
          {a}
        </li>
      ))}
    </ul>
  );

  if (step === 'in_use') {
    return (
      <Dialog
        title={`${name} is in use`}
        tone="danger"
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button className={btnQuiet} onClick={onClose} data-autofocus>
              Keep it approved
            </button>
            <button className={btnDanger} onClick={() => setStep('force')}>
              <AlertTriangle className="w-3.5 h-3.5" />
              Revoke anyway, pause and rebuild these agents
            </button>
          </>
        }
      >
        <p>
          The factory refused: {agents.length === 1 ? 'this agent’s' : `these ${agents.length} agents’`} deployed configuration uses <strong className="font-mono">{name}</strong>.
        </p>
        {agentList}
        <p>The safe path is to redeploy {agents.length === 1 ? 'it' : 'them'} without this version first, then revoke it.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Revoke and pause agents"
      tone="danger"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className={btnQuiet} onClick={() => setStep('in_use')} disabled={busy}>
            Back
          </button>
          <button className={btnDanger} onClick={() => submit(true)} disabled={busy || !acknowledged}>
            {spinner}
            <ShieldOff className="w-3.5 h-3.5" />
            Revoke and pause {agents.length} agent{agents.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p>
        This revokes <strong className="font-mono">{name}</strong> now and pauses:
      </p>
      {agentList}
      <p>
        Each is paused, the skill is removed from its configuration, and it is rebuilt without it; it resumes when that finishes (an agent someone else had paused stays paused). The revocation and every change are recorded in the
        ledger under your name.
      </p>
      <label className="flex items-start gap-2 text-[11px] font-semibold text-rose-800 dark:text-rose-300">
        <input type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
        <span>I understand that {agents.join(', ')} will be paused, changed and rebuilt.</span>
      </label>
      <p className="text-slate-500">Reason: {reason.trim()}</p>
      {errorBox}
    </Dialog>
  );
};


const errorBoxOf = (error: string | null) =>
  error && <p className="text-[11px] text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-300 dark:border-rose-800 rounded px-2 py-1.5">{error}</p>;

/** What the control plane said, in words: its message when it sent one. */
const apiText = (err: unknown): string => {
  const body = err instanceof ApiError ? err.body : null;
  return body?.message ? `${errorText(err)}: ${body.message}` : errorText(err);
};

/**
 * SK6: retire every version of a skill. If no agent runs it, one click and a reason. If agents run it, the factory
 * refuses a plain retire, so this dialog names them, says what a forced retire does to each, and asks for the skill's
 * id to be typed before it sends `force`.
 */
export const RetireDialog: React.FC<{ skill: SkillSummary; adopters: SkillAdopter[]; onClose: () => void; onDone: (message: string) => void }> = ({ skill, adopters, onClose, onDone }) => {
  const [impact, setImpact] = useState(() => retireImpact(adopters));
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The list the screen holds can be a minute old, and this dialog says which agents will be paused: ask again now.
  const [checking, setChecking] = useState(true);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    let live = true;
    factoryApi
      .listSkillAdopters(skill.id)
      .then((fresh) => live && setImpact(retireImpact(fresh)))
      .catch(() => live && setStale(true))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, [skill.id]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await factoryApi.retireSkill(skill.id, { reason: reason.trim() || undefined, force: impact.inUse });
      const paused = res.paused ?? [];
      const removed = res.removedFrom ?? [];
      const failedToPause = res.pauseFailed ?? [];
      onDone(
        `Retired ${skill.id} (${res.retired.length} version${res.retired.length === 1 ? '' : 's'}).` +
          (paused.length ? ` Paused ${paused.join(', ')}.` : '') +
          (removed.length ? ` Removed it from ${removed.join(', ')}; each is rebuilt without it and resumes when that finishes.` : '') +
          (failedToPause.length ? ` Could not pause ${failedToPause.join(', ')} (a built-in agent cannot be paused); it keeps running what it was deployed with until it is rebuilt.` : ''),
      );
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      if (err instanceof ApiError && err.status === 409 && body?.error === 'skill_in_use') {
        // The list was stale: agents now run it. Show them, and ask again with the confirmation.
        setImpact({ agents: Array.isArray(body.agents) ? body.agents.map(String) : [], inUse: true, requestsDropped: impact.requestsDropped });
        setTyped('');
        setError('Agents run this skill now. Review them below and confirm.');
      } else if (body?.error === 'adopters_not_updated') {
        setError(`${body.message ?? 'The skill was not retired.'} Not updated: ${(body.failed ?? body.remaining ?? []).join(', ') || 'unknown'}. Retry to finish.`);
      } else if (body?.error === 'already_retired') {
        setError('This skill is already retired.');
      } else {
        setError(apiText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Retire ${skill.name}`}
      tone="danger"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className={btnQuiet} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={btnDanger} onClick={submit} disabled={busy || checking || !reason.trim() || !retireConfirmed(typed, skill.id, impact)}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Archive className="w-3.5 h-3.5" />}
            {impact.inUse ? `Retire and rebuild ${impact.agents.length} agent${impact.agents.length === 1 ? '' : 's'}` : 'Retire'} {skill.id}
          </button>
        </>
      }
    >
      <p>
        Retiring <strong className="font-mono">{skill.id}</strong> stops any new version being approved or adopted. Every version stays on record.
      </p>
      {checking ? (
        <p className="text-slate-500 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Checking which agents run this skill…
        </p>
      ) : (
        <p className={impact.inUse ? 'font-semibold text-rose-800 dark:text-rose-300' : 'text-slate-600 dark:text-slate-400'}>{retireEffect(impact)}</p>
      )}
      {stale && <p className="text-[11px] text-amber-700 dark:text-amber-400">Could not refresh the list of agents; this is the last one the screen had. The factory still refuses a retire that would surprise you.</p>}
      {impact.inUse && (
        <>
          <ul className="space-y-1">
            {impact.agents.map((a) => (
              <li key={a} className="flex items-center gap-2 font-mono text-[11px] bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 rounded px-2 py-1">
                <PauseCircle className="w-3.5 h-3.5 text-amber-600" />
                {a}
              </li>
            ))}
          </ul>
          <p className="text-slate-500">Each resumes once it is rebuilt without the skill, unless someone else had paused it. Every step is recorded in the ledger under your name.</p>
          <label className="block space-y-1">
            <span className={label}>
              Type <span className="font-mono normal-case">{skill.id}</span> to confirm
            </span>
            <input className={input} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={skill.id} autoComplete="off" />
          </label>
        </>
      )}
      <label className="block space-y-1">
        <span className={label}>Reason (required)</span>
        <textarea className={`${input} h-16`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="Why this skill is going away" />
      </label>
      {errorBoxOf(error)}
    </Dialog>
  );
};

export type AdoptionAction = { kind: 'approve' | 'reject' | 'remove' | 'upgrade'; skill: SkillSummary; adopter: SkillAdopter };

/**
 * SK3, SK5, SK6: decide a request, remove an adoption, or move an agent to the newer approved version. Every one is a
 * change to the agent's configuration that the factory then builds and deploys; an approval adds the skill to the
 * configuration but never grants access (the agent's policy still names the routes, SK2).
 */
export const AdoptionDialog: React.FC<{ action: AdoptionAction; onClose: () => void; onDone: (message: string) => void }> = ({ action, onClose, onDone }) => {
  const { kind, skill, adopter } = action;
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = kind === 'upgrade' ? skill.latestApproved : adopter.version;
  const what = `${skill.id}@${target ?? adopter.version}`;
  const agent = adopter.agentId;
  const ownerPrivate = skill.visibility === 'private' && skill.owner === agent;
  const text = reason.trim() || undefined;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') {
        await factoryApi.approveAdoption(agent, skill.id, text);
        onDone(`Approved ${what} for ${agent}. Its configuration has a new version and ${agent} is being rebuilt with it.`);
      } else if (kind === 'reject') {
        await factoryApi.rejectAdoption(agent, skill.id, text);
        onDone(`Rejected ${agent}’s request for ${what}. Nothing changed.`);
      } else if (kind === 'remove') {
        await factoryApi.removeAdoption(agent, skill.id, text);
        onDone(`Removed ${skill.id} from ${agent}. ${agent} is being rebuilt without it.`);
      } else {
        if (!target) throw new Error('there is no newer approved version');
        await factoryApi.requestAdoption(agent, skill.id, target, text);
        try {
          await factoryApi.approveAdoption(agent, skill.id, text);
        } catch (err) {
          onDone(`Asked for ${what} for ${agent}, but approving it failed (${apiText(err)}). The request is waiting in the list.`);
          return;
        }
        onDone(`Moved ${agent} from ${skill.id}@${adopter.version} to ${what}. It is being rebuilt with it.`);
      }
    } catch (err) {
      const body = err instanceof ApiError ? err.body : null;
      if (body?.error === 'no_request') setError('There is no pending request any more; someone else may have decided it. Refresh the list.');
      else if (body?.error === 'skill_retired') setError('This skill is retired, so it can no longer be adopted.');
      else if (body?.error === 'already_adopted') setError(`${agent} already runs ${what}.`);
      else setError(apiText(err));
    } finally {
      setBusy(false);
    }
  };

  const titles = { approve: `Approve ${skill.name} for ${agent}`, reject: `Reject ${agent}’s request`, remove: `Remove ${skill.name} from ${agent}`, upgrade: `Upgrade ${agent} to ${skill.name} ${skill.latestApproved ?? ''}` };
  const danger = kind === 'remove' || kind === 'reject';
  const Icon = kind === 'approve' ? ShieldCheck : kind === 'upgrade' ? RotateCcw : kind === 'remove' ? UserMinus : XCircle;

  return (
    <Dialog
      title={titles[kind]}
      tone={danger ? 'danger' : 'default'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button className={btnQuiet} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? btnDanger : btnPrimary} data-autofocus onClick={submit} disabled={busy || (kind === 'upgrade' && !target)}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Icon className="w-3.5 h-3.5" />}
            {kind === 'approve' ? 'Approve' : kind === 'reject' ? 'Reject' : kind === 'remove' ? 'Remove' : 'Upgrade'}
          </button>
        </>
      }
    >
      <div className="font-mono text-[11px] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5 space-y-0.5">
        <div className="font-semibold text-slate-800 dark:text-slate-200">{what}</div>
        <div className="text-slate-500">
          agent {agent}
          {/* Who asked is shown when deciding a request. For an upgrade or a removal the person asking now is you, not whoever asked for the adoption. */}
          {(kind === 'approve' || kind === 'reject') && adopter.requestedBy ? ` · asked by ${adopter.requestedBy}` : ''}
        </div>
      </div>
      {kind === 'approve' && (
        <>
          <p>
            This adds <strong className="font-mono">{what}</strong> to {agent}’s configuration as a new version, and {agent} is rebuilt with it. Approving does not grant access: {agent}’s policy still decides which routes the skill may use.
          </p>
          <Requirements requires={skill.requires} />
        </>
      )}
      {kind === 'reject' && <p>{agent} keeps what it has. The request ends and nothing is built.</p>}
      {kind === 'remove' && (
        <>
          <p>{`${skill.id} is taken out of ${agent}’s configuration and ${agent} is rebuilt without it.`}</p>
          {ownerPrivate && <p className="text-slate-500">This is {agent}’s own private skill. Once removed, new versions are not adopted for it automatically: it must ask again and an admin approves.</p>}
        </>
      )}
      {kind === 'upgrade' && (
        <p>
          {agent} moves from <span className="font-mono">{adopter.version}</span> to <span className="font-mono">{skill.latestApproved}</span>. This asks for the new version and approves it in one step, and {agent} is rebuilt with it.
        </p>
      )}
      <label className="block space-y-1">
        <span className={label}>Reason (optional)</span>
        <textarea className={`${input} h-16`} value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} placeholder="Recorded in the ledger" />
      </label>
      {errorBoxOf(error)}
    </Dialog>
  );
};
