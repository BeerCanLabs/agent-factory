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
  /** Optional pre-canonicalized route-relative segment candidates (for routes with an upstream path prefix). */
  suffixCandidates?: readonly string[][];
  /** True when the request path contained malformed percent-encoding (fails closed when the route has held skill actions). */
  malformedPath?: boolean;
};
export type HoldDecision = { held: boolean };

export type CanonicalRouteRequest =
  | { ok: true; malformed: boolean; suffixCandidates: string[][] }
  | { ok: false };

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

function resolveDotSegmentsRfc3986(segs: readonly string[]): string[] {
  const stack: string[] = [];
  for (const s of segs) {
    if (s === '.') continue;
    if (s === '..') {
      stack.pop();
      continue;
    }
    stack.push(s);
  }
  return stack.filter((s) => s.length > 0);
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
  const pushResolved = (resolved: string[]) => {
    const key = `${resolved.length}:${resolved.join('\u0000')}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(resolved);
    }
  };
  const pushCandidate = (segs: readonly string[]) => {
    pushResolved(resolveDotSegments(segs));
    pushResolved(resolveDotSegmentsRfc3986(segs));
  };

  const urlNormalize = (inputPath: string): string => {
    try {
      return new URL('http://localhost/' + inputPath.replace(/^\/+/, '')).pathname;
    } catch {
      return inputPath;
    }
  };

  const collapsed = cut.replace(/\/+/g, '/');
  const cutMatrixStripped = cut
    .split('/')
    .map((s) => s.replace(/;.*$/, ''))
    .join('/');
  const collapsedMatrixStripped = collapsed
    .split('/')
    .map((s) => s.replace(/;.*$/, ''))
    .join('/');

  for (const variant of [
    urlNormalize(cut),
    urlNormalize(collapsed),
    urlNormalize(cutMatrixStripped),
    urlNormalize(collapsedMatrixStripped),
  ]) {
    const rawSegsWithEmpty = variant.replace(/^\//, '').split('/');
    let decodedWithEmpty: string[];
    try {
      decodedWithEmpty = rawSegsWithEmpty.map((s) => decodeURIComponent(s));
    } catch {
      return { malformed: true, candidates: [] };
    }

    pushCandidate(decodedWithEmpty);
    pushCandidate(decodedWithEmpty.map((s) => s.replace(/;.*$/, '')));

    if (decodedWithEmpty.some((s) => s.includes('/') || s.includes('\\'))) {
      const expanded = decodedWithEmpty.flatMap((s) => s.replace(/\\/g, '/').split('/'));
      pushCandidate(expanded);
      pushCandidate(expanded.map((s) => s.replace(/;.*$/, '')));
    }
  }

  return { malformed: false, candidates };
}

/**
 * Canonicalizes `(prefix + requestPath)` across all segment-normalization variants (`.` / `..` / `%2e`, `\` -> `/`,
 * duplicate `/` collapse, `;` matrix parameter stripping, and `%2f` / `%5c` separator expansion) BEFORE checking
 * upstream prefix containment and slicing `prefix` (`S23 F1`).
 *
 * When `prefix` is non-empty, if `requestPath` has malformed percent-encoding or ANY normalized candidate fails to
 * retain `prefix`'s segments as its prefix, returns `{ ok: false }` (`400 bad_path`).
 */
export function canonicalizeRouteRequest(prefix: string, requestPath: string): CanonicalRouteRequest {
  const cleanPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
  const prefixSegs = cleanPrefix
    .split('/')
    .filter((s) => s.length > 0)
    .map(safeDecodeSegment);
  const rawPathname = requestPath.split(/[?#]/, 1)[0] ?? '';
  const combinedRaw = cleanPrefix + (rawPathname.startsWith('/') ? rawPathname : '/' + rawPathname);
  const parsed = buildRequestSegmentCandidates(combinedRaw);

  if (prefixSegs.length === 0) {
    return { ok: true, malformed: parsed.malformed, suffixCandidates: parsed.candidates };
  }
  if (parsed.malformed || parsed.candidates.length === 0) {
    return { ok: false };
  }
  const seen = new Set<string>();
  const suffixCandidates: string[][] = [];
  for (const cand of parsed.candidates) {
    if (cand.length < prefixSegs.length) return { ok: false };
    for (let i = 0; i < prefixSegs.length; i++) {
      if (cand[i] !== prefixSegs[i]) return { ok: false };
    }
    const suffix = cand.slice(prefixSegs.length);
    const key = `${suffix.length}:${suffix.join('\u0000')}`;
    if (!seen.has(key)) {
      seen.add(key);
      suffixCandidates.push(suffix);
    }
  }
  return { ok: true, malformed: false, suffixCandidates };
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
  if (!req.skillActions?.length || !req.route) return undefined;
  if (req.path === undefined && req.suffixCandidates === undefined && !req.malformedPath) return undefined;
  const heldForRoute = req.skillActions.filter((a) => a.hold && a.route === req.route);
  if (heldForRoute.length === 0) return undefined;
  const method = req.method.toUpperCase();
  const parsed =
    req.suffixCandidates !== undefined || req.malformedPath !== undefined
      ? { malformed: Boolean(req.malformedPath), candidates: (req.suffixCandidates ?? []) as string[][] }
      : buildRequestSegmentCandidates(req.path!);
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
