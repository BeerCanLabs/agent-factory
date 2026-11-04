import React, { useEffect, useState } from 'react';
import { factoryApi, type GrantView, type PrincipalView } from '../api/client.js';
import { useAuth } from '../auth/CloudflareAuth.js';
import { validActAs } from '../auth/access-gate.js';

const box = 'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 text-xs';
const input = 'border border-slate-300 dark:border-slate-700 rounded px-2 py-1 bg-transparent';
const btn = 'px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800';

const scopeText = (s: GrantView['scope']) => (s.kind === 'fleet' ? 'fleet' : `${s.kind}:${s.id}`);
function parseScope(v: string): GrantView['scope'] | undefined {
  if (!v || v === 'fleet') return { kind: 'fleet' };
  const m = /^(agent|skill):(.+)$/.exec(v);
  return m ? { kind: m[1], id: m[2] } : undefined;
}

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
  const [form, setForm] = useState({ subject: '', role: 'viewer', scope: 'fleet' });
  const [email, setEmail] = useState<Record<string, string>>({});
  const [person, setPerson] = useState({ name: '', email: '' });
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);

  const load = async () => {
    setError('');
    try {
      const [p, g] = await Promise.all([factoryApi.listPrincipals(), factoryApi.listGrants()]);
      setPrincipals(p.principals);
      setGrants(g.grants);
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
  const domainGrants = grants.filter((g) => g.subject.startsWith('domain:'));

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
        <h2 className="font-semibold mb-2">Grants</h2>
        <div className="flex gap-2 mb-2">
          <input className={input} placeholder="user:alice · domain:example.com · group:ops" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          <input className={input} placeholder="role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
          <input className={input} placeholder="fleet | agent:<id> | skill:<id>" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
          <button className={btn} disabled={!form.subject || !parseScope(form.scope)} onClick={() => act(() => factoryApi.createGrant(form.subject, form.role, parseScope(form.scope)!))}>Grant</button>
        </div>
        <table className="w-full"><tbody>
          {grants.map((g) => (
            <tr key={g.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="py-1 font-mono">{g.subject}</td><td>{g.role}</td><td>{scopeText(g.scope)}</td><td>{g.state ?? 'active'}</td>
              <td className="text-right"><button className={btn} onClick={() => act(() => factoryApi.revokeGrant(g.id))}>Revoke</button></td>
            </tr>
          ))}
        </tbody></table>
        <p className="mt-2 text-slate-500">Domain grants: {domainGrants.length ? domainGrants.map((g) => `${g.subject} → ${g.role}`).join(', ') : 'none'}</p>
      </section>
    </div>
  );
};
