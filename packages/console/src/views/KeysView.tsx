import React, { useEffect, useState } from 'react';
import { factoryApi, type KeyView, type OAuthConsentView } from '../api/client.js';
import { factoryIssuerInfo, type FactoryIssuerInfo } from './keys-model.js';

const btn = 'px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50 transition';
const dangerBtn = 'px-2 py-1 rounded border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/60 disabled:opacity-50 transition';

/** S9 / TSK-340: your own API keys and connected MCP OAuth apps. */
export const KeysView: React.FC = () => {
  const [keys, setKeys] = useState<KeyView[]>([]);
  const [consents, setConsents] = useState<OAuthConsentView[]>([]);
  const [secret, setSecret] = useState('');
  const [family, setFamily] = useState('cli');
  const [error, setError] = useState('');
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);
  const [issuer, setIssuer] = useState<FactoryIssuerInfo>(() =>
    factoryIssuerInfo(typeof window !== 'undefined' ? window.location.origin : ''),
  );

  const load = async () => {
    try {
      const origin = window.location.origin;
      const [keysRes, consentsRes, discovery] = await Promise.all([
        factoryApi.listKeys(),
        factoryApi.listOAuthConsents().catch(() => ({ consents: [] })),
        fetch(`${origin}/.well-known/openid-configuration`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      setKeys(keysRes.keys);
      setConsents(consentsRes.consents || []);
      setIssuer(factoryIssuerInfo(origin, discovery));
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

  const handleRevokeConsent = async (clientId: string) => {
    setError('');
    setRevokingClientId(clientId);
    try {
      await factoryApi.revokeOAuthConsent(clientId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingClientId(null);
    }
  };

  return (
    <div className="space-y-8 text-xs max-w-5xl">
      <div className="space-y-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Factory issuer</h2>
        <p className="text-slate-500 dark:text-slate-400">
          The factory authorization server publishes OpenID and JWKS discovery so MCP and OIDC clients can verify factory-issued tokens. Existing API keys and connected-app tokens stay valid during the Phase 1 dual-run.
        </p>
        <dl className="grid gap-2 sm:grid-cols-1 font-mono text-[11px]">
          <div>
            <dt className="text-slate-500 dark:text-slate-400 uppercase tracking-wide text-[10px] font-sans">Issuer</dt>
            <dd className="break-all text-slate-800 dark:text-slate-200">{issuer.issuer || '—'}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400 uppercase tracking-wide text-[10px] font-sans">OpenID configuration</dt>
            <dd className="break-all text-slate-800 dark:text-slate-200">{issuer.discoveryUrl || '—'}</dd>
          </div>
          <div>
            <dt className="text-slate-500 dark:text-slate-400 uppercase tracking-wide text-[10px] font-sans">JWKS</dt>
            <dd className="break-all text-slate-800 dark:text-slate-200">{issuer.jwksUri || '—'}</dd>
          </div>
        </dl>
      </div>

      {/* API Keys Section */}
      <div className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-900 dark:text-white">Your API keys</h1>
          <p className="text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            Static API keys issued for CLI, scripts, and local developer automation. A new secret is shown once and never stored unhashed. These keys remain valid while the factory also begins issuing short-lived JWTs.
          </p>
        </div>

        {error && (
          <div className="p-3 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800 rounded-lg text-rose-700 dark:text-rose-400">
            {error}
          </div>
        )}

        {secret && (
          <div className="border border-amber-400 bg-amber-50 dark:bg-amber-950/50 rounded-xl p-4 space-y-2">
            <p className="font-semibold text-amber-900 dark:text-amber-200">Copy this key now. It will not be shown again.</p>
            <code className="block break-all font-mono text-[11px] bg-white dark:bg-slate-900 p-2 rounded border border-amber-300 dark:border-amber-800 select-all">
              {secret}
            </code>
            <div>
              <button className={btn} onClick={() => setSecret('')}>
                Done
              </button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <select
            className="border border-slate-300 dark:border-slate-700 rounded px-2.5 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-white"
            value={family}
            onChange={(e) => setFamily(e.target.value)}
          >
            {['cli', 'mcp', 'service', 'automation'].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <button className={btn} onClick={() => run(() => factoryApi.issueKey(family))}>
            Issue key
          </button>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
          <table className="w-full text-left">
            <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
              <tr>
                <th className="px-3 py-2">Key ID</th>
                <th className="px-3 py-2">Device Family</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Last Used</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                    No active API keys issued yet.
                  </td>
                </tr>
              ) : (
                keys.map((k) => (
                  <tr key={k.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-800 dark:text-slate-200">{k.id}</td>
                    <td className="px-3 py-2">{k.deviceFamily}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          k.revokedAt
                            ? 'bg-slate-100 dark:bg-slate-800 text-slate-500'
                            : 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        {k.revokedAt ? 'revoked' : 'active'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-500">{k.lastUsedAt ?? 'never'}</td>
                    <td className="px-3 py-2 text-right space-x-1">
                      {!k.revokedAt && (
                        <>
                          <button className={btn} onClick={() => run(() => factoryApi.rotateKey(k.id))}>
                            Rotate
                          </button>
                          <button className={dangerBtn} onClick={() => run(() => factoryApi.revokeKey(k.id))}>
                            Revoke
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Connected MCP Apps Section */}
      <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-white">Connected MCP Apps</h2>
          <p className="text-slate-500 dark:text-slate-400 text-xs mt-0.5">
            External editors and agents (Cursor, Claude Desktop, VS Code Copilot, Antigravity) authorized via OAuth 2.1 PKCE. Revoking invalidates tokens and active sessions immediately.
          </p>
        </div>

        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900">
          <table className="w-full text-left">
            <thead className="bg-slate-50 dark:bg-slate-950/50 border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500">
              <tr>
                <th className="px-3 py-2">App Name</th>
                <th className="px-3 py-2">Client ID</th>
                <th className="px-3 py-2">Authorized Scopes</th>
                <th className="px-3 py-2">Connected At</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {consents.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                    No external MCP apps connected. When you connect Claude Desktop, Cursor, or VS Code via OAuth 2.1, they will appear here.
                  </td>
                </tr>
              ) : (
                consents.map((c) => (
                  <tr key={c.clientId} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/40">
                    <td className="px-3 py-2 font-medium text-slate-900 dark:text-white">{c.clientName}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-400">{c.clientId}</td>
                    <td className="px-3 py-2 font-mono text-[11px] text-slate-600 dark:text-slate-400">{c.scope}</td>
                    <td className="px-3 py-2 text-slate-500">{new Date(c.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        className={dangerBtn}
                        disabled={revokingClientId === c.clientId}
                        onClick={() => handleRevokeConsent(c.clientId)}
                      >
                        {revokingClientId === c.clientId ? 'Revoking...' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
