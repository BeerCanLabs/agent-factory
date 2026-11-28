// Front-door Phase 1 Slice 5 (#566). Operators read who still uses old credentials.
import type http from 'node:http';
import { json, requirePrivilege, type FactoryState } from './app.js';
import { LegacyCredentialUse, withLedgerSamples } from './legacy-credential-use.js';

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
  const use = state.legacyCredentialUse ?? new LegacyCredentialUse();
  const report = withLedgerSamples(use.snapshot(), state.ledger.query());
  return json(res, 200, report), true;
}
