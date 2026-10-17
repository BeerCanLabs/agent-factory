import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectActionClaims,
  hasAttestedReceipt,
  verifyActionProvenance,
  sanitizeOutputWithProvenance,
  SAFETY_BANNER,
  type ActionClaim,
} from './provenance.js';

describe('Action Provenance Verification (§6.16 AP2)', () => {
  it('detects external action claims across X, GitHub, and LinkedIn', () => {
    const text = `
I have completed the tasks:
1. Posted to X: https://x.com/dsackr/status/1874890330008121820
2. Committed to GitHub: https://github.com/BeerCanLabs/agent-factory/commit/9f8e7d6c5b4a3210
3. Opened PR: https://github.com/BeerCanLabs/agent-factory/pull/42
4. Shared to LinkedIn: https://www.linkedin.com/feed/update/urn:li:share:987654321
`;
    const claims = detectActionClaims(text);
    assert.equal(claims.length, 4);
    assert.deepEqual(claims.map((c) => c.kind), ['x_post', 'github_commit', 'github_pr', 'linkedin_post']);
  });

  it('verifies claims when matching egress receipts exist in run ledger rows', () => {
    const claim: ActionClaim = {
      kind: 'x_post',
      evidence: '1874890330008121820',
      matchedText: 'https://x.com/dsackr/status/1874890330008121820',
    };

    const emptyRows: Array<Record<string, unknown>> = [];
    assert.equal(hasAttestedReceipt(claim, emptyRows), false);

    const withReceipt: Array<Record<string, unknown>> = [
      { type: 'action', action: 'EGRESS', route: 'x' },
    ];
    assert.equal(hasAttestedReceipt(claim, withReceipt), true);

    const withHeldReleased: Array<Record<string, unknown>> = [
      { type: 'action', action: 'HELD_REQUEST_RELEASED', route: 'x' },
    ];
    assert.equal(hasAttestedReceipt(claim, withHeldReleased), true);
  });

  it('replaces unverified action claims with standard SAFETY_BANNER', () => {
    const hallucinatedText =
      'I published the update!\nPosted to X: https://x.com/dsackr/status/1874890330008121820\nHope you like it!';

    const result = verifyActionProvenance(hallucinatedText, []);
    assert.equal(result.verified, false);
    assert.equal(result.unverifiedClaims.length, 1);
    assert.equal(result.unverifiedClaims[0].kind, 'x_post');
    assert.ok(result.sanitizedText.includes(SAFETY_BANNER));
    assert.ok(!result.sanitizedText.includes('https://x.com/dsackr/status/1874890330008121820'));
    assert.equal(
      result.sanitizedText,
      `I published the update!\n${SAFETY_BANNER}\nHope you like it!`,
    );
  });

  it('leaves text unchanged when receipts verify the claims', () => {
    const verifiedText =
      'I published the update!\nPosted to X: https://x.com/dsackr/status/1874890330008121820\nHope you like it!';

    const rows = [{ type: 'action', action: 'EGRESS', route: 'x' }];
    const result = verifyActionProvenance(verifiedText, rows);
    assert.equal(result.verified, true);
    assert.equal(result.unverifiedClaims.length, 0);
    assert.equal(result.sanitizedText, verifiedText);
  });

  it('deeply sanitizes complex output payloads with unverified claims', () => {
    const payload = {
      message: 'Done!',
      nested: {
        announcement: 'Posted to X: https://x.com/dsackr/status/1874890330008121820',
      },
      tags: ['release', 'v1.0'],
    };

    const { sanitized, unverifiedClaims } = sanitizeOutputWithProvenance(payload, []);
    assert.equal(unverifiedClaims.length, 1);
    const s = sanitized as typeof payload;
    assert.equal(s.message, 'Done!');
    assert.equal(s.nested.announcement, SAFETY_BANNER);
    assert.deepEqual(s.tags, ['release', 'v1.0']);
  });
});
