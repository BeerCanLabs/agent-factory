/** E9: which requests on a route are held for a person. Absent: nothing on the route is held. */
export type HoldRule = { methods: string[]; preview?: string };

export type HoldCheck = { hold?: HoldRule; method: string };
export type HoldDecision = { held: boolean };

/** Is this request held? It is when the route has a hold rule and one of its methods equals the request's, ignoring case. */
export function checkHold(req: HoldCheck): HoldDecision {
  const method = req.method.toUpperCase();
  return { held: req.hold?.methods.some((h) => h.toUpperCase() === method) ?? false };
}

export type ToolApprovalCheck = { requireApproval?: string[]; tool: string };
export type ToolApprovalDecision = { approvalRequired: boolean };

/** E4: does this tool call need a person's approval? It does when the policy lists the tool under `requireApproval`. */
export function checkToolApproval(req: ToolApprovalCheck): ToolApprovalDecision {
  return { approvalRequired: req.requireApproval?.includes(req.tool) ?? false };
}
