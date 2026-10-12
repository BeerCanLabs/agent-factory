// SV2 contract (DESIGN_AUTHORITY.md §6.15, Gatekeeper; A1, A2): does this bearer token speak for a live run of the agent
// it names? The Gatekeeper authenticates and never authorizes: a verdict says whose token it is and that the run is
// still live. What the run may then do is the Bouncer's, and which routes ask is the control plane's (the handlers meet
// a request there). The Landlord's run record and its states are not imported: the caller passes the run lookup and
// what "ended" means for its run, as plain values.

/** What a signed run token claims. Signature and expiry are checked by `RunTokens` (packages/auth). */
export type RunClaims = { runId: string; agentId: string };

/** `RunTokens.verify` in `packages/auth`: the claims, or null for anything that is not a valid run token. */
export type RunTokenVerifier = { verify(token: string | undefined): Promise<RunClaims | null> };

export type VerifyRunInput<R extends { agentId: string }> = {
  tokens: RunTokenVerifier;
  /** The bearer token as presented (without the `Bearer ` prefix). */
  token: string | undefined;
  /** The run a route is about. A token for any other run is refused. Omit when the route names no run. */
  runId?: string;
  /** The run with this id, if the factory has one. */
  runOf(runId: string): R | undefined;
  /** True once the run has ended. An ended run's token is refused unless `endedOk` allows it. */
  ended(run: R): boolean;
  /** A case where an ended run's token is still honored (a timed-out run may still post its result). */
  endedOk?(run: R): boolean;
};

export type RunVerdict<R> =
  /** The token is not a run token at all (missing, forged, expired or another kind): the caller may try another kind of caller. */
  | { kind: 'not_a_run_token' }
  /** A valid run token that must not be used here: unknown run, another agent's run, the wrong run, or an ended run. Never falls back to a person. */
  | { kind: 'refused' }
  | { kind: 'ok'; claims: RunClaims; run: R };

export async function verifyRun<R extends { agentId: string }>(input: VerifyRunInput<R>): Promise<RunVerdict<R>> {
  const claims = await input.tokens.verify(input.token);
  if (!claims) return { kind: 'not_a_run_token' };
  if (input.runId !== undefined && claims.runId !== input.runId) return { kind: 'refused' };
  const run = input.runOf(claims.runId);
  if (!run || run.agentId !== claims.agentId) return { kind: 'refused' };
  if (input.ended(run) && !input.endedOk?.(run)) return { kind: 'refused' };
  return { kind: 'ok', claims, run };
}
