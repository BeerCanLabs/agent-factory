// Front-door Phase 1 Slice 5 (#566). Operators read who still uses old credentials.
import type http from 'node:http';
import { json, requirePrivilege, type FactoryState } from './app.js';

/** GET /api/v1/auth/legacy-credentials — counts from auth.request log lines and ledger samples. */
export async function handleLegacyCredentialRoutes(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  if (!(path === '/api/v1/auth/legacy-credentials' && req.method === 'GET')) return false;
  const principal = await requirePrivilege(req, res, state, 'ledger.read');
  if (!principal) return true;
  const report = state.legacyCredentialUse?.snapshot() ?? {
    source: 'auth.request' as const,
    ledgerAction: 'AUTH_LEGACY_CREDENTIAL' as const,
    kinds: [],
  };
  return json(res, 200, report), true;
}
