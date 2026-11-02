/** E9: which requests on a route are held for a person. Absent: nothing on the route is held. */
export type HoldRule = { methods: string[]; preview?: string };

/**
 * E9, S23 (D31): effective per-action hold rule from an agent's adopted skills (`manifestHold || overrideHold`).
 * When a request matches `route`, HTTP `method`, and `path` template of any adopted skill action with `hold: true`,
 * the request is held for human approval even if the route itself does not hold that HTTP method globally.
 */
export type SkillActionHoldRule = {
  skillId?: string;
  actionId: string;
  route: string;
  method: string;
  path: string;
  hold: boolean;
};

export type HoldCheck = {
  hold?: HoldRule;
  skillActions?: readonly SkillActionHoldRule[];
  route?: string;
  method: string;
  path?: string;
};
export type HoldDecision = { held: boolean };

function splitSegments(rawPath: string): string[] {
  const cut = rawPath.split(/[?#]/, 1)[0] ?? '';
  const trimmed = cut.replace(/^\/+|\/+$/g, '');
  return trimmed ? trimmed.split('/') : [];
}

function matchSegment(patternSeg: string, reqSeg: string): boolean {
  if (!patternSeg.includes('{')) return patternSeg === reqSeg;
  if (/^\{[A-Za-z0-9_.-]+\}$/.test(patternSeg)) return reqSeg.length > 0;
  const parts = patternSeg.split(/\{[A-Za-z0-9_.-]+\}/);
  if (parts.length === 1) return patternSeg === reqSeg;
  if (!reqSeg.startsWith(parts[0]!)) return false;
  const last = parts[parts.length - 1]!;
  if (!reqSeg.endsWith(last)) return false;
  let pos = parts[0]!.length;
  const endLimit = reqSeg.length - last.length;
  if (pos > endLimit) return false;
  for (let i = 1; i < parts.length - 1; i++) {
    const lit = parts[i]!;
    // Require at least 1 character for the preceding placeholder.
    const idx = reqSeg.indexOf(lit, pos + 1);
    if (idx === -1 || idx + lit.length > endLimit) return false;
    pos = idx + lit.length;
  }
  // Ensure the final placeholder matched at least 1 character before `last`.
  return endLimit - pos >= 1;
}

/** Matches an HTTP request path against a skill action path pattern (exact segments and `{param}` templates). */
export function matchSkillActionPath(pattern: string, requestPath: string): boolean {
  const pSegs = splitSegments(pattern);
  const rSegs = splitSegments(requestPath);
  if (pSegs.length !== rSegs.length) return false;
  for (let i = 0; i < pSegs.length; i++) {
    if (!matchSegment(pSegs[i]!, rSegs[i]!)) return false;
  }
  return true;
}

/** Returns the first matching skill action rule with `hold: true` for this request, if any. */
export function findHeldSkillAction(req: HoldCheck): SkillActionHoldRule | undefined {
  if (!req.skillActions?.length || !req.route || req.path === undefined) return undefined;
  const method = req.method.toUpperCase();
  return req.skillActions.find(
    (a) => a.hold && a.route === req.route && a.method.toUpperCase() === method && matchSkillActionPath(a.path, req.path!),
  );
}

/**
 * Is this request held? It is when either:
 * 1. the route has a hold rule whose `methods` includes the request method (ignoring case), or
 * 2. an adopted skill action matching `route`, `method`, and `path` has effective `hold: true` (S23).
 */
export function checkHold(req: HoldCheck): HoldDecision {
  const method = req.method.toUpperCase();
  if (req.hold?.methods.some((h) => h.toUpperCase() === method)) return { held: true };
  if (findHeldSkillAction(req)) return { held: true };
  return { held: false };
}

export type ToolApprovalCheck = { requireApproval?: string[]; tool: string };
export type ToolApprovalDecision = { approvalRequired: boolean };

/** E4: does this tool call need a person's approval? It does when the policy lists the tool under `requireApproval`. */
export function checkToolApproval(req: ToolApprovalCheck): ToolApprovalDecision {
  return { approvalRequired: req.requireApproval?.includes(req.tool) ?? false };
}
