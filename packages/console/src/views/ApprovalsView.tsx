import React, { useEffect, useState } from 'react';
import { CheckSquare, Check, X, Clock, FileCode, MessageSquare, Globe, Lock, Send, Eye } from 'lucide-react';
import type { ApprovalItem, HeldRequestCopy } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi } from '../api/client.js';
import { Dialog } from '../components/Dialog.js';
import {
  DECISION_PAGE_INTRO,
  EGRESS_PAGE_INTRO,
  STORIES_NOT_FILED,
  approvalLabel,
  approveBlocked,
  approveConfirm,
  decisionCard,
  decisionSubmit,
  defaultCapText,
  formatUsd,
  isDecisionHold,
  rejectConfirm,
  revisionLines,
  type DecisionCard,
  type StoryRow,
} from './approvals-model.js';

interface ApprovalsViewProps {
  approvals: ApprovalItem[];
  onRefresh: () => void;
}

interface ApprovalsPanelProps extends ApprovalsViewProps {
  canDecide: boolean;
  /** When set, the cap field starts as this text instead of the P90 default. */
  initialCap?: string;
}

/** LinkedIn's limit for a post's text. */
const LINKEDIN_POST_LIMIT = 3000;

type Decision = { approval: ApprovalItem; decision: 'approve' | 'reject'; notes: string; capUsd?: number };

function bodyText(req: HeldRequestCopy): string {
  if (req.bodyEncoding === 'utf8') return req.body;
  try {
    return atob(req.body);
  } catch {
    return req.body;
  }
}

function bodyJson(req: HeldRequestCopy): Record<string, any> | undefined {
  try {
    const v = JSON.parse(bodyText(req));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** LinkedIn "little text": reserved characters arrive backslash-escaped; show them as the reader will see them. */
const unescapeLittleText = (s: string) =>
  s
    .replace(/\{hashtag\|\\?#\|([^}]+)\}/g, '#$1')
    .replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1');

/** E9: the held post as it will appear on LinkedIn: text, link card, audience. */
const LinkedInPostPreview: React.FC<{ approval: ApprovalItem; post: Record<string, any> }> = ({ approval, post }) => {
  const text = unescapeLittleText(typeof post.commentary === 'string' ? post.commentary : '');
  const article = post.content?.article as { source?: string; title?: string; description?: string } | undefined;
  const media = post.content?.media || post.content?.multiImage;
  const isPublic = (post.visibility ?? 'PUBLIC') === 'PUBLIC';
  const tooLong = text.length > LINKEDIN_POST_LIMIT;
  return (
    <div className="max-w-xl mx-auto bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg shadow-sm">
      <div className="flex items-center gap-3 px-4 pt-4">
        <div className="w-11 h-11 rounded-full bg-sky-700 text-white flex items-center justify-center text-sm font-bold">in</div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">Your LinkedIn profile</div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center gap-1">
            Drafted by <strong className="text-slate-700 dark:text-slate-300">{approval.agentId}</strong> · Now ·
            {isPublic ? <Globe className="w-3 h-3" aria-label="Anyone" /> : <Lock className="w-3 h-3" aria-label="Connections only" />}
            <span>{isPublic ? 'Anyone' : 'Connections only'}</span>
          </div>
        </div>
      </div>
      <div className="px-4 py-3 text-sm text-slate-900 dark:text-slate-100 whitespace-pre-wrap break-words leading-relaxed">
        {text.split(/(#[\p{L}\p{N}_]+)/u).map((part, i) =>
          part.startsWith('#') ? (
            <span key={i} className="text-sky-700 dark:text-sky-400 font-semibold">{part}</span>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          ),
        )}
        {!text && <span className="italic text-slate-400">(no text)</span>}
      </div>
      {article?.source && (
        <a href={article.source} target="_blank" rel="noreferrer noopener" className="block border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 px-4 py-3 hover:bg-slate-100 dark:hover:bg-slate-800">
          <div className="text-sm font-semibold text-slate-900 dark:text-white">{article.title || article.source}</div>
          {article.description && <div className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{article.description}</div>}
          <div className="text-[11px] text-slate-500 mt-1 truncate">{article.source}</div>
        </a>
      )}
      {media && <div className="border-t border-slate-200 dark:border-slate-800 px-4 py-3 text-xs text-slate-500">Includes media (shown as attached on LinkedIn).</div>}
      <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 px-4 py-2 text-[11px] text-slate-500 dark:text-slate-400">
        <span className={tooLong ? 'text-rose-600 dark:text-rose-400 font-semibold' : ''}>
          {text.length.toLocaleString()} / {LINKEDIN_POST_LIMIT.toLocaleString()} characters{tooLong ? ': LinkedIn will refuse this' : ''}
        </span>
        <span>{post.lifecycleState === 'DRAFT' ? 'Saved as a LinkedIn draft' : 'Publishes when approved'}</span>
      </div>
    </div>
  );
};

const RawRequest: React.FC<{ request: HeldRequestCopy }> = ({ request }) => {
  const parsed = bodyJson(request);
  return (
    <pre className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 text-xs font-mono text-emerald-700 dark:text-emerald-300 overflow-x-auto max-h-80">
      {`${request.method} ${request.path}\n`}
      {Object.entries(request.headers).map(([k, v]) => `${k}: ${v}\n`).join('')}
      {'\n'}
      {parsed ? JSON.stringify(parsed, null, 2) : bodyText(request)}
    </pre>
  );
};

function money(n: number | undefined): string {
  return n === undefined ? '' : formatUsd(n);
}

const ColumnTable: React.FC<{ caption: string; headers: string[]; rows: string[][]; moneyColumn?: number }> = ({ caption, headers, rows, moneyColumn }) => {
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{caption}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h} className="py-1 pr-3 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-slate-200 dark:border-slate-800">
                {row.map((cell, j) => (
                  <td key={j} className={`py-1 pr-3 ${j === moneyColumn ? 'text-right font-mono' : ''}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

function storyCells(row: StoryRow, withCost: boolean): string[] {
  const cells = [row.title, row.dor ?? '', row.dod ?? ''];
  if (withCost) cells.push(money(row.costUsd));
  return cells;
}

/** GAP-259: the context Dale needs before approving a spend. Nothing here is an egress request. */
const DecisionHoldBody: React.FC<{ card: DecisionCard }> = ({ card }) => {
  const budget = card.budget;
  const storyCost = card.stories.some((s) => s.costUsd !== undefined);
  return (
    <div className="space-y-4 text-xs text-slate-700 dark:text-slate-300">
      {card.summary && <p className="text-sm text-slate-800 dark:text-slate-100 whitespace-pre-wrap">{card.summary}</p>}
      {card.link && (
        <a href={card.link} target="_blank" rel="noreferrer noopener" className="inline-block text-sky-700 dark:text-sky-400 font-semibold hover:underline">
          Plan pull request
        </a>
      )}
      {card.requestKey && <p className="font-mono text-[10px] text-slate-400">request {card.requestKey}</p>}
      {card.approvers.length > 0 && <p>Approvers: {card.approvers.join(', ')}</p>}
      {budget && (
        <div className="space-y-3">
          {budget.amountOnly !== undefined && (
            <p>
              <span className="text-[11px] uppercase tracking-wide text-slate-500">Estimate </span>
              <span className="text-sm font-semibold text-slate-900 dark:text-white">{formatUsd(budget.amountOnly)}</span>
            </p>
          )}
          {(budget.expectedUsd !== undefined || budget.p90Usd !== undefined) && (
            <dl className="grid grid-cols-2 gap-3 max-w-sm">
              {budget.expectedUsd !== undefined && (
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">Expected</dt>
                  <dd className="text-sm font-semibold text-slate-900 dark:text-white">{formatUsd(budget.expectedUsd)}</dd>
                </div>
              )}
              {budget.p90Usd !== undefined && (
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-slate-500">P90</dt>
                  <dd className="text-sm font-semibold text-slate-900 dark:text-white">{formatUsd(budget.p90Usd)}</dd>
                </div>
              )}
            </dl>
          )}
          {(budget.modelCostUsd !== undefined || budget.infraCostUsd !== undefined) && (
            <p className="text-[11px] text-slate-500">
              {budget.modelCostUsd !== undefined && <span>Model {formatUsd(budget.modelCostUsd)}</span>}
              {budget.modelCostUsd !== undefined && budget.infraCostUsd !== undefined && <span> · </span>}
              {budget.infraCostUsd !== undefined && <span>Infrastructure {formatUsd(budget.infraCostUsd)}</span>}
            </p>
          )}
          {(budget.method || budget.uncertainty) && (
            <p className="text-[11px] text-slate-500">
              {budget.method && <span>Method: {budget.method}</span>}
              {budget.method && budget.uncertainty && <span> · </span>}
              {budget.uncertainty && <span>Uncertainty: {budget.uncertainty}</span>}
            </p>
          )}
          {budget.estimate && <p className="whitespace-pre-wrap">{budget.estimate}</p>}
          {revisionLines(budget).length > 0 && <p>{revisionLines(budget).join(' · ')}</p>}
          <ColumnTable
            caption="Per role"
            headers={['Stage', 'Role', 'Model', 'Cost']}
            moneyColumn={3}
            rows={budget.byAgent.map((r) => [r.stage, r.role, r.model, money(r.costUsd)])}
          />
          <ColumnTable
            caption="Per stage"
            headers={['Stage', 'Cost']}
            moneyColumn={1}
            rows={budget.byStage.map((r) => [r.stage, money(r.costUsd)])}
          />
          <ColumnTable
            caption="Per story"
            headers={['Story', 'Cost']}
            moneyColumn={1}
            rows={budget.byStory.map((r) => [r.title, money(r.costUsd)])}
          />
          <ColumnTable
            caption="Model rates"
            headers={['Model', 'Input / 1M', 'Output / 1M']}
            rows={budget.rates.map((r) => [r.model, money(r.inputPerMTok), money(r.outputPerMTok)])}
          />
        </div>
      )}
      {card.finopsUrl && (
        <a href={card.finopsUrl} target="_blank" rel="noreferrer noopener" className="inline-block text-sky-700 dark:text-sky-400 font-semibold hover:underline">
          FinOps estimate
        </a>
      )}
      {card.epics.length > 0 && (
        <ColumnTable
          caption="Epics"
          headers={['Epic', 'DoR', 'DoD']}
          rows={card.epics.map((e) => [e.title, e.dor ?? '', e.dod ?? ''])}
        />
      )}
      {card.storiesFiled ? (
        <ColumnTable
          caption="Stories"
          headers={storyCost ? ['Story', 'DoR', 'DoD', 'Cost'] : ['Story', 'DoR', 'DoD']}
          moneyColumn={storyCost ? 3 : undefined}
          rows={card.stories.map((s) => storyCells(s, storyCost))}
        />
      ) : (
        <p>{STORIES_NOT_FILED}</p>
      )}
    </div>
  );
};

export const ApprovalsPanel: React.FC<ApprovalsPanelProps> = ({ approvals, onRefresh, canDecide, initialCap }) => {
  const [selectedId, setSelectedId] = useState<string | null>(approvals[0]?.approvalId ?? null);
  const [notes, setNotes] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const selected = approvals.find((a) => a.approvalId === selectedId) ?? approvals[0] ?? null;
  const shownCap = !selected
    ? ''
    : Object.prototype.hasOwnProperty.call(drafts, selected.approvalId)
      ? drafts[selected.approvalId]
      : initialCap !== undefined
        ? initialCap
        : defaultCapText(selected);
  const card = selected && isDecisionHold(selected) ? decisionCard(selected) : null;
  useEffect(() => {
    setNotes('');
    setShowRaw(false);
    setError(null);
  }, [selected?.approvalId]);

  const post = selected?.request?.preview === 'linkedin-post' ? bodyJson(selected.request) : undefined;

  const submit = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      const out = await factoryApi.decideApproval(pending.approval.approvalId, pending.decision, pending.notes || undefined, pending.capUsd);
      const who = pending.approval.agentId;
      const decisionHold = isDecisionHold(pending.approval);
      const heard = decisionHold
        ? out.delivered === 'mailbox'
          ? `${who} has the decision`
          : out.delivered === 'run'
            ? `${who} was woken with the decision`
            : out.delivered === 'not_delivered'
              ? `${who} could not be told (see the ledger)`
              : undefined
        : out.delivered === 'mailbox'
          ? `${who} has it now`
          : out.delivered === 'run'
            ? `${who} was woken with it`
            : out.delivered === 'not_delivered'
              ? `${who} could not be told (see the ledger)`
              : undefined;
      const what =
        pending.decision === 'approve'
          ? pending.approval.kind === 'held'
            ? `Approved. ${who} sends it now, exactly as shown`
            : decisionHold
              ? 'Approved. The run was not paused, and nothing was sent'
              : 'Approved'
          : decisionHold
            ? 'Rejected. Nothing was sent'
            : pending.notes
              ? `Sent back to ${who} with your notes`
              : 'Rejected. Nothing was sent';
      setNotice(heard ? `${what}; ${heard}.` : `${what}.`);
      setPending(null);
      setNotes('');
      onRefresh();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const capBlocks = selected ? approveBlocked(selected, shownCap) : false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <CheckSquare className="w-5 h-5 text-amber-500 dark:text-amber-400" />
            <span>Approvals</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {selected && isDecisionHold(selected) ? DECISION_PAGE_INTRO : EGRESS_PAGE_INTRO}
          </p>
        </div>
        <div className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-400 border border-amber-300 dark:border-amber-800">
          {approvals.length} waiting
        </div>
      </div>

      {notice && (
        <div className="text-xs font-semibold text-emerald-800 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-300 dark:border-emerald-800 rounded-lg px-3 py-2">{notice}</div>
      )}

      {approvals.length === 0 || !selected ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-12 text-center space-y-2 shadow-sm">
          <h3 className="text-base font-bold text-slate-900 dark:text-white">Nothing waiting for you</h3>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-sm mx-auto">Posts and other actions an agent takes in your name appear here before anything is sent.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="space-y-3">
            {approvals.map((a) => (
              <button
                key={a.approvalId}
                onClick={() => setSelectedId(a.approvalId)}
                className={`w-full text-left p-4 rounded-xl border transition ${
                  a.approvalId === selected.approvalId
                    ? 'bg-amber-500/10 border-amber-500 shadow-md'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="text-xs font-bold text-slate-900 dark:text-white mb-1 truncate">{approvalLabel(a)}</div>
                <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                  <span>From <strong className="text-slate-700 dark:text-slate-200">{a.agentId}</strong></span>
                  <span className="flex items-center space-x-1">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(a.requestedAt).toLocaleString()}</span>
                  </span>
                </div>
              </button>
            ))}
          </div>

          <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 shadow-sm">
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">{approvalLabel(selected)}</h3>
                {isDecisionHold(selected) ? (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    <strong className="text-slate-700 dark:text-slate-200">{selected.agentId}</strong> asked in run <code className="font-mono">{selected.runId}</code>. The run is not paused.
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    {selected.agentId} via route <code className="font-mono">{selected.route}</code>
                    {selected.kind === 'held' ? '' : ` · run ${selected.runId}`}
                  </p>
                )}
              </div>
              {selected.request && (
                <button onClick={() => setShowRaw((v) => !v)} className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 hover:underline">
                  {showRaw ? <Eye className="w-3.5 h-3.5" /> : <FileCode className="w-3.5 h-3.5" />}
                  {showRaw ? 'Show preview' : 'Show exact request'}
                </button>
              )}
            </div>

            {card ? (
              <DecisionHoldBody card={card} />
            ) : selected.request ? (
              post && !showRaw ? <LinkedInPostPreview approval={selected} post={post} /> : <RawRequest request={selected.request} />
            ) : (
              <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <div>
                  Tool call <code className="font-mono">{selected.tool}</code>. Its run is paused until you decide.
                </div>
                <div className="font-mono text-[10px] text-slate-400">arguments sha256 {selected.argsSha256}</div>
              </div>
            )}

            <div className="space-y-2 pt-2">
              {isDecisionHold(selected) && selected.hold?.requiresCap && (
                <div className="space-y-1">
                  <label htmlFor="approval-cap" className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Spending cap (USD)
                  </label>
                  <input
                    id="approval-cap"
                    inputMode="decimal"
                    autoComplete="off"
                    value={shownCap}
                    aria-invalid={capBlocks}
                    onChange={(e) => setDrafts((d) => ({ ...d, [selected.approvalId]: e.target.value }))}
                    className="w-full max-w-xs bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-emerald-500"
                  />
                  {shownCap !== '' && shownCap === defaultCapText(selected) && (
                    <p className="text-[11px] text-slate-500">Defaults to the P90 estimate.</p>
                  )}
                  {capBlocks && <p className="text-[11px] text-rose-600 dark:text-rose-400">Enter a dollar amount, such as 16.63, to approve.</p>}
                </div>
              )}
              <label htmlFor="approval-notes" className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" /> Notes for {selected.agentId}
              </label>
              <textarea
                id="approval-notes"
                rows={3}
                placeholder="What to change, or why. Sent with your decision."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-emerald-500"
              />
              {!canDecide && <p className="text-[11px] text-slate-500">Deciding needs the approver role.</p>}
              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => {
                    const req = decisionSubmit(selected, 'reject', notes, shownCap);
                    if (req.blocked) return;
                    setPending({ approval: selected, decision: 'reject', notes: req.notes ?? '' });
                  }}
                  disabled={!canDecide}
                  className="px-4 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900/60 dark:hover:bg-red-800 disabled:opacity-40 text-red-700 dark:text-red-200 border border-red-300 dark:border-red-700/80 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                >
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
                {selected.kind === 'held' && (
                  <button
                    onClick={() => setPending({ approval: selected, decision: 'reject', notes: notes.trim() })}
                    disabled={!canDecide || !notes.trim()}
                    title={notes.trim() ? undefined : 'Write notes first'}
                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-40 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" /> Send back with notes
                  </button>
                )}
                <button
                  onClick={() => {
                    const req = decisionSubmit(selected, 'approve', notes, shownCap);
                    if (req.blocked) return;
                    setPending({ approval: selected, decision: 'approve', notes: req.notes ?? '', capUsd: req.capUsd });
                  }}
                  disabled={!canDecide || capBlocks}
                  className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow"
                >
                  <Check className="w-3.5 h-3.5" /> {post ? 'Approve and post' : 'Approve'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <Dialog
          title={
            pending.decision === 'approve'
              ? isDecisionHold(pending.approval)
                ? pending.approval.hold?.requiresCap
                  ? 'Approve this spend?'
                  : 'Approve this decision?'
                : post
                  ? 'Post this to LinkedIn?'
                  : 'Approve this?'
              : isDecisionHold(pending.approval)
                ? 'Reject this?'
                : pending.notes
                  ? 'Send back with notes?'
                  : 'Reject this?'
          }
          tone={pending.decision === 'approve' ? 'default' : 'danger'}
          busy={busy}
          onClose={() => setPending(null)}
          footer={
            <>
              <button onClick={() => setPending(null)} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40">
                Cancel
              </button>
              <button
                data-autofocus
                onClick={submit}
                disabled={busy}
                className={`px-4 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-40 ${pending.decision === 'approve' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500'}`}
              >
                {busy
                  ? 'Sending…'
                  : pending.decision === 'approve'
                    ? post && !isDecisionHold(pending.approval)
                      ? 'Approve and post'
                      : 'Approve'
                    : isDecisionHold(pending.approval)
                      ? 'Reject'
                      : pending.notes
                        ? 'Send back'
                        : 'Reject'}
              </button>
            </>
          }
        >
          <p>
            {pending.decision === 'approve'
              ? approveConfirm(pending.approval, { capUsd: pending.capUsd, linkedIn: Boolean(post) && !isDecisionHold(pending.approval) })
              : rejectConfirm(pending.approval, pending.notes)}
          </p>
          {pending.notes && <blockquote className="border-l-2 border-slate-300 dark:border-slate-700 pl-3 italic">{pending.notes}</blockquote>}
          {error && <p className="text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
        </Dialog>
      )}
    </div>
  );
};

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({ approvals, onRefresh }) => {
  const permissions = usePermissions();
  return <ApprovalsPanel approvals={approvals} onRefresh={onRefresh} canDecide={permissions.canApproveTool} />;
};
