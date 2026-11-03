import http from 'node:http';
import { json, readJson, requirePrivilege, type FactoryState } from './app.js';
import { createSubmission } from './submissions.js';

/**
 * S21: a guided interview for people who are not technical. The questions are fixed; the answers are validated step by
 * step and turned into an ordinary S20 agent draft through `createSubmission`, so the interview grants nothing: the same
 * security, compliance and budget gates run and an approver still admits it.
 */
export const INTERVIEW_STEPS = [
  { id: 'name', question: 'What should the agent be called?', type: 'text', required: true },
  { id: 'kind', question: 'Is it just for you (personal) or for a team?', type: 'choice', choices: ['personal', 'team'], required: true },
  { id: 'lead', question: 'Who is accountable for the team agent? (their factory id, e.g. user:dale)', type: 'text', when: { kind: 'team' }, required: true },
  { id: 'purpose', question: 'In a few sentences, what is it for and how should it behave?', type: 'text', required: true },
  { id: 'skills', question: 'Which skills should it use? (optional, skill ids)', type: 'list', required: false },
] as const;

export type InterviewAnswers = { name?: unknown; kind?: unknown; lead?: unknown; purpose?: unknown; skills?: unknown };
type StepError = { step: string; message: string };

/** Validates every step; returns the per-step problems, or the agent configuration the answers describe. */
export function draftFromInterview(a: InterviewAnswers): { ok: true; content: Record<string, unknown> } | { ok: false; errors: StepError[] } {
  const errors: StepError[] = [];
  const name = typeof a.name === 'string' ? a.name.trim() : '';
  if (!name || name.length > 120) errors.push({ step: 'name', message: 'give a name of 1 to 120 characters' });
  const kind = a.kind;
  if (kind !== 'personal' && kind !== 'team') errors.push({ step: 'kind', message: "answer 'personal' or 'team'" });
  const lead = typeof a.lead === 'string' ? a.lead.trim() : '';
  if (kind === 'team' && !lead) errors.push({ step: 'lead', message: 'a team agent needs an accountable lead' });
  if (kind === 'personal' && lead) errors.push({ step: 'lead', message: 'a personal agent has no lead; it is yours' });
  const purpose = typeof a.purpose === 'string' ? a.purpose.trim() : '';
  if (purpose.length < 10 || purpose.length > 8000) errors.push({ step: 'purpose', message: 'describe the purpose in 10 to 8000 characters' });
  const skills = a.skills === undefined ? [] : a.skills;
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(s))) {
    errors.push({ step: 'skills', message: 'skills must be a list of skill ids' });
  }
  if (errors.length) return { ok: false, errors };
  const id = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 64) || 'agent';
  return {
    ok: true,
    content: {
      id,
      name,
      kind,
      ...(kind === 'team' ? { accountableLead: lead } : {}),
      soul: purpose,
      memory: { archetype: kind === 'team' ? 'team-member' : 'personal-assistant' },
      ...((skills as string[]).length ? { skills } : {}),
    },
  };
}

export async function handleInterview(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/submissions/interview' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'content.submit'))) return true;
    json(res, 200, { steps: INTERVIEW_STEPS });
    return true;
  }
  if (path === '/api/v1/submissions/interview' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'content.submit');
    if (!principal) return true;
    const body = await readJson(req);
    const answers = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as InterviewAnswers;
    const drafted = draftFromInterview(answers);
    if (!drafted.ok) {
      json(res, 400, { error: 'interview_incomplete', errors: drafted.errors });
      return true;
    }
    if (body.finalize !== true) {
      json(res, 200, { preview: drafted.content });
      return true;
    }
    const sub = await createSubmission(state, principal, 'agent', drafted.content);
    json(res, 201, sub);
    return true;
  }
  return false;
}
