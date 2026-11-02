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

function safeDecodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function resolveDotSegments(segs: readonly string[]): string[] {
  const stack: string[] = [];
  for (const s of segs) {
    if (!s || s === '.') continue;
    if (s === '..') {
      stack.pop();
      continue;
    }
    stack.push(s);
  }
  return stack;
}

function splitPatternSegments(pattern: string): string[] {
  const cut = (pattern.split(/[?#]/, 1)[0] ?? '').replace(/\\/g, '/');
  let normalized = cut;
  if (!cut.includes('{')) {
    try {
      normalized = new URL('http://localhost/' + cut.replace(/^\/+/, '')).pathname;
    } catch {
      normalized = cut;
    }
  }
  return normalized
    .split('/')
    .filter((s) => s.length > 0)
    .map((seg) => (seg.includes('{') ? seg : safeDecodeSegment(seg)));
}

function buildRequestSegmentCandidates(rawPath: string): { malformed: boolean; candidates: string[][] } {
  const cut = (rawPath.split(/[?#]/, 1)[0] ?? '').replace(/\\/g, '/');
  for (const rawSeg of cut.split('/')) {
    try {
      decodeURIComponent(rawSeg);
    } catch {
      return { malformed: true, candidates: [] };
    }
  }

  const seen = new Set<string>();
  const candidates: string[][] = [];
  const pushCandidate = (segs: string[]) => {
    const resolved = resolveDotSegments(segs);
    const key = `${resolved.length}:${resolved.join('\u0000')}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(resolved);
    }
  };

  const urlNormalize = (inputPath: string): string => {
    try {
      return new URL('http://localhost/' + inputPath.replace(/^\/+/, '')).pathname;
    } catch {
      return inputPath;
    }
  };

  const collapsed = cut.replace(/\/+/g, '/');
  const matrixStrippedPath = collapsed
    .split('/')
    .map((s) => s.replace(/;.*$/, ''))
    .join('/');

  for (const variant of [urlNormalize(cut), urlNormalize(collapsed), urlNormalize(matrixStrippedPath)]) {
    const rawSegs = variant.split('/').filter((s) => s.length > 0);
    let decodedSegs: string[];
    try {
      decodedSegs = rawSegs.map((s) => decodeURIComponent(s));
    } catch {
      return { malformed: true, candidates: [] };
    }

    pushCandidate(decodedSegs);
    pushCandidate(decodedSegs.map((s) => s.replace(/;.*$/, '')).filter((s) => s.length > 0));

    if (decodedSegs.some((s) => s.includes('/') || s.includes('\\'))) {
      const expanded = decodedSegs.flatMap((s) => s.replace(/\\/g, '/').split('/')).filter((s) => s.length > 0);
      pushCandidate(expanded);
      pushCandidate(expanded.map((s) => s.replace(/;.*$/, '')).filter((s) => s.length > 0));
    }
  }

  return { malformed: false, candidates };
}

function matchSegment(patternSeg: string, reqSeg: string): boolean {
  if (!patternSeg.includes('{')) {
    return patternSeg === reqSeg || patternSeg === reqSeg.replace(/;.*$/, '');
  }
  if (/^\{[A-Za-z0-9_.-]+\}$/.test(patternSeg)) return reqSeg.length > 0;
  const parts = patternSeg.split(/\{[A-Za-z0-9_.-]+\}/).map(safeDecodeSegment);
  if (parts.length === 1) return parts[0] === reqSeg || parts[0] === reqSeg.replace(/;.*$/, '');
  const matchAgainst = (candidateSeg: string): boolean => {
    if (!candidateSeg.startsWith(parts[0]!)) return false;
    const last = parts[parts.length - 1]!;
    if (!candidateSeg.endsWith(last)) return false;
    let pos = parts[0]!.length;
    const endLimit = candidateSeg.length - last.length;
    if (pos > endLimit) return false;
    for (let i = 1; i < parts.length - 1; i++) {
      const lit = parts[i]!;
      // Require at least 1 character for the preceding placeholder.
      const idx = candidateSeg.indexOf(lit, pos + 1);
      if (idx === -1 || idx + lit.length > endLimit) return false;
      pos = idx + lit.length;
    }
    // Ensure the final placeholder matched at least 1 character before `last`.
    return endLimit - pos >= 1;
  };
  if (matchAgainst(reqSeg)) return true;
  const stripped = reqSeg.replace(/;.*$/, '');
  return stripped !== reqSeg && stripped.length > 0 ? matchAgainst(stripped) : false;
}

function matchSegments(pSegs: readonly string[], rSegs: readonly string[]): boolean {
  if (pSegs.length !== rSegs.length) return false;
  for (let i = 0; i < pSegs.length; i++) {
    if (!matchSegment(pSegs[i]!, rSegs[i]!)) return false;
  }
  return true;
}

function matchPatternAgainstCandidates(pattern: string, candidates: readonly string[][]): boolean {
  const pSegs = splitPatternSegments(pattern);
  return candidates.some((rSegs) => matchSegments(pSegs, rSegs));
}

/** Matches an HTTP request path against a skill action path pattern (exact segments and `{param}` templates). */
export function matchSkillActionPath(pattern: string, requestPath: string): boolean {
  const parsed = buildRequestSegmentCandidates(requestPath);
  if (parsed.malformed) return true;
  return matchPatternAgainstCandidates(pattern, parsed.candidates);
}

/** Returns the first matching skill action rule with `hold: true` for this request, if any. */
export function findHeldSkillAction(req: HoldCheck): SkillActionHoldRule | undefined {
  if (!req.skillActions?.length || !req.route || req.path === undefined) return undefined;
  const heldForRoute = req.skillActions.filter((a) => a.hold && a.route === req.route);
  if (heldForRoute.length === 0) return undefined;
  const method = req.method.toUpperCase();
  const parsed = buildRequestSegmentCandidates(req.path);
  if (parsed.malformed) {
    return heldForRoute.find((a) => a.method.toUpperCase() === method) ?? heldForRoute[0];
  }
  return heldForRoute.find(
    (a) => a.method.toUpperCase() === method && matchPatternAgainstCandidates(a.path, parsed.candidates),
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
