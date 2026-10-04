/** E4: what the gatekeeper-egress asks the control plane when a tool call is marked `requireApproval`. */
export type ApprovalRequest = { runId: string; route: string; tool: string; argsSha256: string };

/** E4: the control plane's answer to an `ApprovalRequest`. */
export type ApprovalOutcome = { approvalId: string; state: 'pending' | 'approved' | 'rejected' | 'consumed' };

/** E9: what the gatekeeper-egress sends the control plane about a held request (the credential is never part of it). */
export type HoldRequest = {
  runId: string;
  route: string;
  argsSha256: string;
  request: { method: string; path: string; headers: Record<string, string>; body: string; bodyEncoding: 'utf8' | 'base64'; preview?: string };
};
export type HoldOutcome = { approvalId: string; state: 'pending' | 'approved' | 'rejected' | 'consumed'; notes?: string };

/**
 * E9: the request headers that change what a held request does, so they are part of the reviewed copy and its hash
 * (an approved body cannot be re-sent as another operation). Everything else is transport.
 */
export const HELD_HEADERS = ['content-type', 'x-restli-method', 'x-http-method-override', 'x-http-method', 'x-method-override', 'linkedin-version'];
/** E9: the largest request the gatekeeper-egress will hold for review, in raw bytes. */
export const HELD_BODY_LIMIT = 192 * 1024;
/** E9: the same limit as the control plane stores it: the base64 text of `HELD_BODY_LIMIT` bytes. One rule, two units. */
export const HELD_STORED_BODY_LIMIT = Math.ceil(HELD_BODY_LIMIT / 3) * 4;
