import React, { useEffect, useState } from 'react';
import { CheckSquare, Check, X, Clock, FileCode, MessageSquare, Globe, Lock, Send, Eye } from 'lucide-react';
import type { ApprovalItem, HeldRequestCopy } from '../api/types.js';
import { usePermissions } from '../auth/usePermissions.js';
import { factoryApi } from '../api/client.js';
import { Dialog } from '../components/Dialog.js';

interface ApprovalsViewProps {
  approvals: ApprovalItem[];
  onRefresh: () => void;
}

/** LinkedIn's limit for a post's text. */
const LINKEDIN_POST_LIMIT = 3000;

type Decision = { approval: ApprovalItem; decision: 'approve' | 'reject'; notes: string };

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
const unescapeLittleText = (s: string) => s.replace(/\\([\\|{}@[\]()<>#*_~])/g, '$1');

const describe = (a: ApprovalItem) =>
  a.request?.preview === 'linkedin-post' ? 'LinkedIn post' : a.kind === 'held' ? `${a.request?.method ?? ''} ${a.route}` : a.tool;

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

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({ approvals, onRefresh }) => {
  const permissions = usePermissions();
  const [selectedId, setSelectedId] = useState<string | null>(approvals[0]?.approvalId ?? null);
  const [notes, setNotes] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = approvals.find((a) => a.approvalId === selectedId) ?? approvals[0] ?? null;
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
      const out = await factoryApi.decideApproval(pending.approval.approvalId, pending.decision, pending.notes || undefined);
      const who = pending.approval.agentId;
      const heard = out.delivered === 'mailbox' ? `${who} has it now` : out.delivered === 'run' ? `${who} was woken with it` : out.delivered === 'not_delivered' ? `${who} could not be told (see the ledger)` : undefined;
      const what =
        pending.decision === 'approve'
          ? pending.approval.kind === 'held'
            ? `Approved. ${who} sends it now, exactly as shown`
            : 'Approved'
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <CheckSquare className="w-5 h-5 text-amber-500 dark:text-amber-400" />
            <span>Approvals</span>
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Held by the gatekeeper-egress: nothing here has been sent. Approving sends exactly what you see, once.
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
                <div className="text-xs font-bold text-slate-900 dark:text-white mb-1 truncate">{describe(a)}</div>
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
                <h3 className="text-base font-bold text-slate-900 dark:text-white">{describe(selected)}</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {selected.agentId} via route <code className="font-mono">{selected.route}</code>
                  {selected.kind === 'held' ? '' : ` · run ${selected.runId}`}
                </p>
              </div>
              {selected.request && (
                <button onClick={() => setShowRaw((v) => !v)} className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1 hover:underline">
                  {showRaw ? <Eye className="w-3.5 h-3.5" /> : <FileCode className="w-3.5 h-3.5" />}
                  {showRaw ? 'Show preview' : 'Show exact request'}
                </button>
              )}
            </div>

            {selected.request ? (
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
              {!permissions.canApproveTool && <p className="text-[11px] text-slate-500">Deciding needs the approver role.</p>}
              <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                <button
                  onClick={() => setPending({ approval: selected, decision: 'reject', notes: '' })}
                  disabled={!permissions.canApproveTool}
                  className="px-4 py-2 bg-red-100 hover:bg-red-200 dark:bg-red-900/60 dark:hover:bg-red-800 disabled:opacity-40 text-red-700 dark:text-red-200 border border-red-300 dark:border-red-700/80 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                >
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
                {selected.kind === 'held' && (
                  <button
                    onClick={() => setPending({ approval: selected, decision: 'reject', notes: notes.trim() })}
                    disabled={!permissions.canApproveTool || !notes.trim()}
                    title={notes.trim() ? undefined : 'Write notes first'}
                    className="px-4 py-2 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 disabled:opacity-40 text-slate-800 dark:text-slate-100 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5" /> Send back with notes
                  </button>
                )}
                <button
                  onClick={() => setPending({ approval: selected, decision: 'approve', notes: notes.trim() })}
                  disabled={!permissions.canApproveTool}
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
          title={pending.decision === 'approve' ? (post ? 'Post this to LinkedIn?' : 'Approve this?') : pending.notes ? 'Send back with notes?' : 'Reject this?'}
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
                {busy ? 'Sending…' : pending.decision === 'approve' ? (post ? 'Approve and post' : 'Approve') : pending.notes ? 'Send back' : 'Reject'}
              </button>
            </>
          }
        >
          {pending.decision === 'approve' ? (
            <p>
              {pending.approval.kind === 'held'
                ? `${pending.approval.agentId} will send exactly what you reviewed, once${post ? ', and it goes live on your LinkedIn profile' : ''}. Any change would need your approval again.`
                : `The run continues and makes this tool call once.`}
            </p>
          ) : pending.notes ? (
            <p>Nothing is sent. {pending.approval.agentId} gets your notes and can submit a revised version for you to review.</p>
          ) : (
            <p>Nothing is sent, and {pending.approval.agentId} is told it was rejected.</p>
          )}
          {pending.notes && <blockquote className="border-l-2 border-slate-300 dark:border-slate-700 pl-3 italic">{pending.notes}</blockquote>}
          {error && <p className="text-rose-600 dark:text-rose-400 font-semibold">{error}</p>}
        </Dialog>
      )}
    </div>
  );
};
