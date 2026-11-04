import React, { useEffect, useState } from 'react';
import { factoryApi, type GrantView, type PrincipalView } from '../api/client.js';
import { useAuth } from '../auth/CloudflareAuth.js';
import { validActAs } from '../auth/access-gate.js';
import { AGENT_ROLES, FLEET_ROLES, filterAccess, grantsToCreate, groupGrants } from './people-model.js';

const box = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-xs';
const input = 'border border-slate-300 dark:border-slate-700 rounded px-2 py-1 bg-transparent';
const btn = 'px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800';


/** #434: the Add person form is ready when there is a name (1..256) and one plausible email. */
export function validNewPerson(name: string, email: string): boolean {
  const n = name.trim();
  return n.length > 0 && n.length <= 256 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/** S9: principals (1..N emails), domain grants and role grants; Act-As. Shown only to holders of `grants.manage`. */
export const PeopleView: React.FC = () => {
  const { setActAs } = useAuth();
  const [principals, setPrincipals] = useState<PrincipalView[]>([]);
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ subject: string; role: string; scope: 'fleet' | 'agents'; agents: string[] }>({ subject: '', role: 'viewer', scope: 'fleet', agents: [] });
  const [agents, setAgents] = useState<{ id: string; name: string }[]>([]);
  const [q, setQ] = useState('');
  const [email, setEmail] = useState<Record<string, string>>({});
  const [person, setPerson] = useState({ name: '', email: '' });
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);

  const load = async () => {
    setError('');
    try {
      const [p, g, a] = await Promise.all([factoryApi.listPrincipals(), factoryApi.listGrants(), factoryApi.listAgents().catch(() => [])]);
      setPrincipals(p.principals);
      setGrants(g.grants);
      setAgents(a.map((x) => ({ id: x.id, name: x.name || x.id })));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), []);
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const agentNames = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const access = filterAccess(groupGrants(principals, grants, agentNames), q);
  const toCreate = grantsToCreate(form.subject, form.role, form.scope, form.agents);
  const revokeAll = (id: string, name: string) => {
    if (!window.confirm(`Revoke ALL access for ${name} (${id})?\n\nRemoves every grant and group membership and ends their sign-in sessions and CLI logins. Their API keys stay but have no power without grants.`)) return;
    void act(() => factoryApi.revokeAllAccess(id));
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">People &amp; Access</h1>
      {error && <p className="text-red-600 text-xs">{error}</p>}
      <section className={box}>
        <h2 className="font-semibold mb-2">Principals</h2>
        <form
          className="flex gap-2 mb-2"
          aria-label="Add person"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validNewPerson(person.name, person.email)) return;
            void act(async () => {
              await factoryApi.createPrincipal(person.name, person.email);
              setPerson({ name: '', email: '' });
            });
          }}
        >
          <input className={input} placeholder="Display name" aria-label="Display name" value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} />
          <input className={input} type="email" placeholder="email@example.com" aria-label="Email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} />
          <button type="submit" className={btn} disabled={!validNewPerson(person.name, person.email)}>Add person</button>
        </form>
        <table className="w-full"><tbody>
          {principals.map((p) => (
            <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-1">
                {rename?.id === p.id ? (
                  <span className="space-x-1">
                    <input className={input} aria-label="New display name" value={rename.name} onChange={(e) => setRename({ id: p.id, name: e.target.value })} />
                    <button className={btn} disabled={!rename.name.trim() || rename.name.trim().length > 256} onClick={() => act(async () => { await factoryApi.renamePrincipal(p.id, rename.name); setRename(null); })}>Save</button>
                    <button className={btn} onClick={() => setRename(null)}>Cancel</button>
                  </span>
                ) : (
                  <>
                    <span className="font-medium">{p.displayName || p.id}</span>{' '}
                    <span className="font-mono text-slate-500">{p.id}</span>{' '}
                    <button className={btn} onClick={() => setRename({ id: p.id, name: p.displayName ?? '' })}>Edit</button>
                  </>
                )}
              </td>
              <td>{(p.emails ?? []).join(', ')}</td>
              <td className="text-right space-x-1">
                <input className={input} placeholder="add email" value={email[p.id] ?? ''} onChange={(e) => setEmail({ ...email, [p.id]: e.target.value })} />
                <button className={btn} disabled={!email[p.id]} onClick={() => act(() => factoryApi.addPrincipalEmail(p.id, email[p.id]))}>Add</button>
                {validActAs(p.id) && <button className={btn} onClick={() => setActAs(p.id)}>Act as</button>}
              </td>
            </tr>
          ))}
        </tbody></table>
      </section>
      <section className={box}>
        <h2 className="font-semibold mb-2">Access by person</h2>
        <form
          className="flex flex-wrap gap-2 mb-3 items-start"
          aria-label="Grant access"
          onSubmit={(e) => {
            e.preventDefault();
            if (!toCreate.length) return;
            void act(async () => {
              for (const g of toCreate) await factoryApi.createGrant(g.subject, g.role, g.scope);
              setForm({ ...form, agents: [] });
            });
          }}
        >
          <select className={input} aria-label="Person" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })}>
            <option value="">Person…</option>
            {principals.map((p) => <option key={p.id} value={p.id}>{p.displayName || p.id} ({p.id})</option>)}
          </select>
          <select className={input} aria-label="Scope" value={form.scope} onChange={(e) => { const scope = e.target.value as 'fleet' | 'agents'; setForm({ ...form, scope, role: scope === 'fleet' ? 'viewer' : 'member' }); }}>
            <option value="fleet">Fleet</option>
            <option value="agents">Agents</option>
          </select>
          <select className={input} aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {(form.scope === 'fleet' ? FLEET_ROLES : AGENT_ROLES).map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {form.scope === 'agents' && (
            <select className={input} aria-label="Agents" multiple size={Math.min(6, Math.max(2, agents.length))} value={form.agents} onChange={(e) => setForm({ ...form, agents: [...e.target.selectedOptions].map((o) => o.value) })}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <button type="submit" className={btn} disabled={!toCreate.length}>Grant{toCreate.length > 1 ? ` (${toCreate.length})` : ''}</button>
        </form>
        <input className={`${input} mb-2 w-full`} placeholder="Search people, roles or agents" aria-label="Search access" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="space-y-2">
          {access.map((p) => (
            <div key={p.subject} className="border-t border-slate-100 dark:border-slate-800 pt-2">
              <div className="flex items-center justify-between">
                <div><span className="font-medium">{p.name}</span> <span className="font-mono text-slate-500">{p.subject}</span></div>
                {p.subject.startsWith('user:') && <button className={`${btn} text-red-700 dark:text-red-400`} onClick={() => revokeAll(p.subject, p.name)}>Revoke all access</button>}
              </div>
              {p.fleet.length > 0 && (
                <div className="mt-1">Fleet: {p.fleet.map((f) => (
                  <span key={f.grantId} className="inline-flex items-center mr-2">{f.role}<button className="ml-1 text-slate-400 hover:text-red-600" aria-label={`Revoke ${f.role}`} onClick={() => act(() => factoryApi.revokeGrant(f.grantId))}>×</button></span>
                ))}</div>
              )}
              {p.agents.map((r) => (
                <div key={r.role} className="mt-1">{r.role} on: {r.items.map((i) => (
                  <span key={i.grantId} className="inline-flex items-center mr-2">{i.name}<button className="ml-1 text-slate-400 hover:text-red-600" aria-label={`Revoke ${r.role} on ${i.name}`} onClick={() => act(() => factoryApi.revokeGrant(i.grantId))}>×</button></span>
                ))}</div>
              ))}
              {p.other.map((o) => (
                <div key={o.grantId} className="mt-1">{o.role} on {o.scope}<button className="ml-1 text-slate-400 hover:text-red-600" aria-label={`Revoke ${o.role} on ${o.scope}`} onClick={() => act(() => factoryApi.revokeGrant(o.grantId))}>×</button></div>
              ))}
            </div>
          ))}
          {access.length === 0 && <p className="text-slate-500">No matching access.</p>}
        </div>
      </section>
    </div>
  );
};
