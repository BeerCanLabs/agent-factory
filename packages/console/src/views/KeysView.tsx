import React, { useEffect, useState } from 'react';
import { factoryApi, type KeyView } from '../api/client.js';

const btn = 'px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800';

/** S9: your own API keys: issue, rotate, revoke. A new secret is shown once, here, and never again. */
export const KeysView: React.FC = () => {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [secret, setSecret] = useState('');
  const [family, setFamily] = useState('cli');
  const [error, setError] = useState('');
  const load = async () => {
    try {
      setKeys((await factoryApi.listKeys()).keys);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => void load(), []);
  const run = async (f: () => Promise<{ secret?: string } | unknown>) => {
    setError('');
    try {
      const out = (await f()) as { secret?: string };
      setSecret(out?.secret ?? '');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="space-y-4 text-xs">
      <h1 className="text-lg font-semibold">Your API keys</h1>
      {error && <p className="text-red-600">{error}</p>}
      {secret && (
        <div className="border border-amber-400 rounded p-3">
          <p className="font-semibold">Copy this key now. It will not be shown again.</p>
          <code className="break-all">{secret}</code>
          <div><button className={btn} onClick={() => setSecret('')}>Done</button></div>
        </div>
      )}
      <div className="flex gap-2">
        <select className="border rounded px-2 bg-transparent" value={family} onChange={(e) => setFamily(e.target.value)}>
          {['cli', 'mcp', 'service', 'automation'].map((f) => <option key={f}>{f}</option>)}
        </select>
        <button className={btn} onClick={() => run(() => factoryApi.issueKey(family))}>Issue key</button>
      </div>
      <table className="w-full"><tbody>
        {keys.map((k) => (
          <tr key={k.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="py-1 font-mono">{k.id}</td><td>{k.deviceFamily}</td><td>{k.revokedAt ? 'revoked' : 'active'}</td><td>{k.lastUsedAt ?? ''}</td>
            <td className="text-right space-x-1">{!k.revokedAt && (<><button className={btn} onClick={() => run(() => factoryApi.rotateKey(k.id))}>Rotate</button><button className={btn} onClick={() => run(() => factoryApi.revokeKey(k.id))}>Revoke</button></>)}</td>
          </tr>
        ))}
      </tbody></table>
    </div>
  );
};
