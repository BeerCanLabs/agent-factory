// DESIGN_AUTHORITY.md §6.11 K4 (GAP-067): agents direct people only to the factory's reconnect link. The Gatekeeper's
// egress calls these functions on routes marked `stripSignInLinks` (its route test is in gatekeeper-egress).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripSignInLinksFromText } from './signin-links.js';

const FACTORY = 'https://agent-factory.example.com';
const INVENTED =
  'Connect here: [LinkedIn](https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=78vvuoe69uhartg&redirect_uri=https://api.emailengine.app/oauth) ' +
  'and https://accounts.google.com/o/oauth2/v2/auth?client_id=YOUR_GOOGLE_CLIENT_ID';
const REAL = `${FACTORY}/api/v1/connections/castle/linkedin/start`;

describe('K4 sign-in link rule', () => {
  it('K4 without a factory URL every sign-in link is removed', () => {
    const r = stripSignInLinksFromText(`${REAL} and ${INVENTED}`, undefined);
    assert.equal(r.removed, 3);
    assert.ok(!r.text.includes('http'));
  });
});
