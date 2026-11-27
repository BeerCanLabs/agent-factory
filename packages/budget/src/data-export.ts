/**
 * AWS Data Export rows mapped onto the BeerCanLabs cost center (DESIGN_AUTHORITY §6.15, issue #457).
 *
 * Dale's rule: AI, cloud, and tech spend sits in cost center `beercanlabs`. The `project` tag is a sub-center.
 * A missing, foreign, or non-kebab `cost-center` value is sub-center `untagged`. The ingest queues a backfill
 * proposal for Dale and never applies a tag. No cloud SDK here; the S3 reader lives in the AWS accountant adapter.
 */
import { isCloudCredit, type CloudCostSnapshot, type CloudSummary, type CostLine, type UsageLine } from './cloud.js';

export const BEERCANLABS_COST_CENTER = 'beercanlabs' as const;
export const UNTAGGED_SUB_CENTER = 'untagged' as const;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BACKFILL = 100;

export type AllocationTag = 'cost-center' | 'project' | 'env' | 'owner';
export type TagBackfillReason = 'missing-cost-center' | 'foreign-cost-center' | 'invalid-tag';

export type ExportTags = Record<AllocationTag, string | null>;

export type ExportRow = {
  recordType: string;
  service: string;
  usageType: string;
  resourceId: string | null;
  usd: number;
  quantity: number;
  /** UTC day `YYYY-MM-DD`, or null when the file did not date the row. */
  usageStart: string | null;
  tags: ExportTags;
};

export type TagBackfillProposal = {
  status: 'proposed';
  applied: false;
  queuedFor: 'dale';
  reason: TagBackfillReason;
  service: string;
  resourceId: string | null;
  observedCostCenter: string | null;
  proposedTags: { 'cost-center': typeof BEERCANLABS_COST_CENTER };
  usd: number;
};

export type CostAllocation = {
  costCenter: typeof BEERCANLABS_COST_CENTER;
  source: 'aws-data-export' | 'cost-explorer-fallback';
  totalUsd: number;
  taggedUsd: number;
  untaggedUsd: number;
  /** Share of gross usage whose cost-center tag is `beercanlabs`. */
  taggedFraction: number;
  /** Every gross dollar is assigned to `beercanlabs`, including untagged lines. */
  centerCoverage: 1;
  bySubCenter: Array<{ subCenter: string; usd: number }>;
  byService: Array<{ service: string; usd: number; taggedUsd: number; untaggedUsd: number }>;
  byProject: Array<{ project: string; usd: number }>;
  byTag: Record<AllocationTag, Array<{ value: string; usd: number }>>;
  backfill: TagBackfillProposal[];
  backfillTruncated: boolean;
  notes: string[];
};

const r4 = (n: number) => Math.round(n * 10000) / 10000 + 0;

const ALLOCATION_NOTES = [
  'Every dollar is mapped to cost center beercanlabs. The sub-center is the project tag, or untagged.',
  'A missing, foreign, or non-kebab cost-center tag is sub-center untagged. The backfill is proposed for Dale and is not applied.',
  'The only factory cost center is beercanlabs.',
];

const COST_HEADERS = ['line_item_unblended_cost', 'lineitem/unblendedcost'];
const TYPE_HEADERS = ['line_item_line_item_type', 'lineitem/lineitemtype'];
const SERVICE_HEADERS = ['product_product_name', 'product/productname', 'product_servicename'];
const CODE_HEADERS = ['line_item_product_code', 'lineitem/productcode', 'product_servicecode'];
const USAGE_HEADERS = ['line_item_usage_type', 'lineitem/usagetype'];
const RESOURCE_HEADERS = ['line_item_resource_id', 'lineitem/resourceid'];
const AMOUNT_HEADERS = ['line_item_usage_amount', 'lineitem/usageamount'];
const START_HEADERS = ['line_item_usage_start_date', 'lineitem/usagestartdate', 'bill_billing_period_start_date', 'bill/billingperiodstartdate'];
const MAP_HEADERS = ['resource_tags', 'resourcetags'];

const emptyTags = (): ExportTags => ({ 'cost-center': null, project: null, env: null, owner: null });

/** `user:cost-center`, `user_cost_center`, and the bare key all name the same allocation tag. */
export function allocationTag(raw: string): AllocationTag | undefined {
  const key = raw.trim().toLowerCase().replace(/^user[:_]/, '').replace(/_/g, '-');
  if (key === 'cost-center' || key === 'project' || key === 'env' || key === 'owner') return key;
  return undefined;
}

function headerTag(header: string): AllocationTag | undefined {
  const h = header.toLowerCase().replace(/\s+/g, '');
  const m = /^(?:resource_tags|resourcetags)[/_:]*user[:_](cost-center|cost_center|project|env|owner)$/.exec(h);
  if (!m) return undefined;
  return allocationTag(m[1].replace(/_/g, '-'));
}

function normHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, '');
}

function findCol(headers: string[], names: string[]): number {
  return headers.findIndex((h) => names.includes(h));
}

/** RFC 4180, enough for a CUR 2.0 text export. A quoted comma stays inside its field. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function cell(row: string[], index: number): string {
  if (index < 0) return '';
  return (row[index] ?? '').trim();
}

function dayOf(raw: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  return m ? m[1] : null;
}

function tagsFromMap(raw: string): Partial<ExportTags> {
  const s = raw.trim();
  if (!s || s === '{}' || s.toLowerCase() === 'null') return {};
  const out: Partial<ExportTags> = {};
  const put = (key: string, value: string) => {
    const tag = allocationTag(key);
    const v = value.trim();
    if (tag && v && v.toLowerCase() !== 'null') out[tag] = v;
  };
  if (s.startsWith('{') && s.endsWith('}') && s.includes(':') && s.includes('"')) {
    try {
      const obj = JSON.parse(s) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof v === 'string' || typeof v === 'number') put(k, String(v));
        }
        return out;
      }
    } catch {
      // Fall through to the brace form AWS sometimes writes.
    }
  }
  const body = s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : s;
  if (!body.includes('=')) return out;
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    put(part.slice(0, eq), part.slice(eq + 1));
  }
  return out;
}

/**
 * Parse one CUR 2.0 (snake_case) or legacy CUR (slash headers) text object.
 * Throws when the header has no unblended-cost column, so a bad object falls back to Cost Explorer
 * instead of reporting a zero bill.
 */
export function rowsFromDataExport(csv: string): ExportRow[] {
  const table = parseCsv(csv);
  if (table.length === 0) return [];
  const headers = table[0].map(normHeader);
  const costAt = findCol(headers, COST_HEADERS);
  const serviceAt = findCol(headers, SERVICE_HEADERS);
  const codeAt = findCol(headers, CODE_HEADERS);
  if (costAt < 0 || (serviceAt < 0 && codeAt < 0)) {
    throw new Error('unrecognized AWS data export: no unblended cost and service columns');
  }
  const typeAt = findCol(headers, TYPE_HEADERS);
  const usageAt = findCol(headers, USAGE_HEADERS);
  const resourceAt = findCol(headers, RESOURCE_HEADERS);
  const amountAt = findCol(headers, AMOUNT_HEADERS);
  const startAt = findCol(headers, START_HEADERS);
  const mapAt = findCol(headers, MAP_HEADERS);
  const tagCols = headers.flatMap((h, index) => {
    const tag = headerTag(h);
    return tag ? [{ index, tag }] : [];
  });
  const rows: ExportRow[] = [];
  for (const raw of table.slice(1)) {
    const usd = Number(cell(raw, costAt));
    if (!Number.isFinite(usd)) continue;
    const service = cell(raw, serviceAt) || cell(raw, codeAt) || 'Unknown';
    const tags = emptyTags();
    if (mapAt >= 0) Object.assign(tags, tagsFromMap(cell(raw, mapAt)));
    for (const col of tagCols) {
      const v = cell(raw, col.index);
      if (v && v.toLowerCase() !== 'null') tags[col.tag] = v;
    }
    const resource = cell(raw, resourceAt);
    rows.push({
      recordType: cell(raw, typeAt) || 'Usage',
      service,
      usageType: cell(raw, usageAt) || 'Unknown',
      resourceId: resource || null,
      usd,
      quantity: Number(cell(raw, amountAt)) || 0,
      usageStart: dayOf(cell(raw, startAt)),
      tags,
    });
  }
  return rows;
}

function inWindow(row: ExportRow, window: { start: string; end: string }): boolean {
  if (!row.usageStart) return true;
  return row.usageStart >= window.start && row.usageStart < window.end;
}

function observedTag(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return KEBAB.test(lower) ? lower : raw.trim();
}

type Classified = { tagged: boolean; subCenter: string; reason?: TagBackfillReason; observed: string | null };

function classify(tags: ExportTags): Classified {
  const raw = tags['cost-center'];
  if (!raw || !raw.trim()) return { tagged: false, subCenter: UNTAGGED_SUB_CENTER, reason: 'missing-cost-center', observed: null };
  const lower = raw.trim().toLowerCase();
  if (!KEBAB.test(lower)) return { tagged: false, subCenter: UNTAGGED_SUB_CENTER, reason: 'invalid-tag', observed: raw.trim() };
  if (lower !== BEERCANLABS_COST_CENTER) return { tagged: false, subCenter: UNTAGGED_SUB_CENTER, reason: 'foreign-cost-center', observed: raw.trim() };
  const project = tags.project?.trim() ?? '';
  const projectKey = project.toLowerCase();
  const subCenter = project && KEBAB.test(projectKey) ? projectKey : UNTAGGED_SUB_CENTER;
  return { tagged: true, subCenter, observed: lower };
}

function add(map: Map<string, number>, key: string, usd: number) {
  map.set(key, (map.get(key) ?? 0) + usd);
}

function ranked(map: Map<string, number>): Array<{ key: string; usd: number }> {
  return [...map.entries()]
    .map(([key, usd]) => ({ key, usd: r4(usd) }))
    .filter((x) => x.usd >= 0.0001)
    .sort((a, b) => b.usd - a.usd || a.key.localeCompare(b.key));
}

/** Gross usage in the window, with the BeerCanLabs mapping. Credits stay on the snapshot and out of the center split. */
export function snapshotFromRows(rows: ExportRow[], window: { start: string; end: string }): CloudCostSnapshot {
  const kept = rows.filter((r) => inWindow(r, window));
  const lineMap = new Map<string, number>();
  const usageMap = new Map<string, { usd: number; quantity: number }>();
  let tagged = 0;
  let untagged = 0;
  const sub = new Map<string, number>();
  const serviceTagged = new Map<string, { usd: number; tagged: number; untagged: number }>();
  const projects = new Map<string, number>();
  const tags: Record<AllocationTag, Map<string, number>> = {
    'cost-center': new Map(),
    project: new Map(),
    env: new Map(),
    owner: new Map(),
  };
  const proposals = new Map<string, TagBackfillProposal>();

  for (const row of kept) {
    const lineKey = `${row.recordType}\0${row.service}`;
    add(lineMap, lineKey, row.usd);
    if (isCloudCredit(row.recordType, row.usd)) continue;
    const usageKey = `${row.service}\0${row.usageType}`;
    const u = usageMap.get(usageKey) ?? { usd: 0, quantity: 0 };
    u.usd += row.usd;
    u.quantity += row.quantity;
    usageMap.set(usageKey, u);
    if (row.usd === 0) continue;
    const c = classify(row.tags);
    if (c.tagged) tagged += row.usd;
    else untagged += row.usd;
    add(sub, c.subCenter, row.usd);
    const svc = serviceTagged.get(row.service) ?? { usd: 0, tagged: 0, untagged: 0 };
    svc.usd += row.usd;
    if (c.tagged) svc.tagged += row.usd;
    else svc.untagged += row.usd;
    serviceTagged.set(row.service, svc);
    if (c.tagged && c.subCenter !== UNTAGGED_SUB_CENTER) add(projects, c.subCenter, row.usd);
    for (const key of ['cost-center', 'project', 'env', 'owner'] as const) {
      const raw = row.tags[key];
      if (raw && raw.trim()) add(tags[key], observedTag(raw), row.usd);
    }
    if (c.reason) {
      const id = `${c.reason}\0${row.service}\0${row.resourceId ?? ''}\0${c.observed ?? ''}`;
      const prev = proposals.get(id);
      if (prev) prev.usd += row.usd;
      else {
        proposals.set(id, {
          status: 'proposed',
          applied: false,
          queuedFor: 'dale',
          reason: c.reason,
          service: row.service,
          resourceId: row.resourceId,
          observedCostCenter: c.observed,
          proposedTags: { 'cost-center': BEERCANLABS_COST_CENTER },
          usd: row.usd,
        });
      }
    }
  }

  const lines: CostLine[] = [...lineMap.entries()].map(([key, usd]) => {
    const [recordType, service] = key.split('\0');
    return { recordType, service, usd: r4(usd) };
  });
  const usage: UsageLine[] = [...usageMap.entries()].map(([key, v]) => {
    const [service, usageType] = key.split('\0');
    return { service, usageType, usd: r4(v.usd), quantity: r4(v.quantity) };
  });
  const ordered = [...proposals.values()].sort((a, b) => b.usd - a.usd || a.service.localeCompare(b.service));
  const backfill = ordered.slice(0, MAX_BACKFILL).map((p) => ({ ...p, usd: r4(p.usd) }));
  const tagList = (key: AllocationTag) => ranked(tags[key]).map(({ key: value, usd }) => ({ value, usd }));
  const allocation: CostAllocation = {
    costCenter: BEERCANLABS_COST_CENTER,
    source: 'aws-data-export',
    totalUsd: r4(tagged + untagged),
    taggedUsd: r4(tagged),
    untaggedUsd: r4(untagged),
    taggedFraction: tagged + untagged > 0 ? r4(tagged / (tagged + untagged)) : 1,
    centerCoverage: 1,
    bySubCenter: ranked(sub).map(({ key: subCenter, usd }) => ({ subCenter, usd })),
    byService: [...serviceTagged.entries()]
      .map(([service, v]) => ({ service, usd: r4(v.usd), taggedUsd: r4(v.tagged), untaggedUsd: r4(v.untagged) }))
      .filter((x) => x.usd >= 0.0001)
      .sort((a, b) => b.usd - a.usd || a.service.localeCompare(b.service)),
    byProject: ranked(projects).map(({ key: project, usd }) => ({ project, usd })),
    byTag: { 'cost-center': tagList('cost-center'), project: tagList('project'), env: tagList('env'), owner: tagList('owner') },
    backfill,
    backfillTruncated: ordered.length > MAX_BACKFILL,
    notes: ALLOCATION_NOTES,
  };
  return { provider: 'aws', start: window.start, end: window.end, lines, usage, allocation };
}

/** Cost Explorer (or any tag-less bill) still maps the whole gross to BeerCanLabs / untagged. */
export function beerCanLabsFallback(summary: CloudSummary, note?: string): CostAllocation {
  const total = summary.grossUsd;
  const byService = summary.infraByService.map((s) => ({ service: s.service, usd: s.usd, taggedUsd: 0, untaggedUsd: s.usd }));
  if (summary.aiBilledByCloudUsd >= 0.0001) {
    byService.push({ service: 'model inference', usd: r4(summary.aiBilledByCloudUsd), taggedUsd: 0, untaggedUsd: r4(summary.aiBilledByCloudUsd) });
  }
  byService.sort((a, b) => b.usd - a.usd || a.service.localeCompare(b.service));
  const notes = [...ALLOCATION_NOTES];
  notes[0] = note ?? 'No Data Export object has landed for this period. Totals are Cost Explorer. Every dollar is mapped to cost center beercanlabs, sub-center untagged.';
  return {
    costCenter: BEERCANLABS_COST_CENTER,
    source: 'cost-explorer-fallback',
    totalUsd: r4(total),
    taggedUsd: 0,
    untaggedUsd: r4(total),
    taggedFraction: total > 0 ? 0 : 1,
    centerCoverage: 1,
    bySubCenter: total > 0 ? [{ subCenter: UNTAGGED_SUB_CENTER, usd: r4(total) }] : [],
    byService,
    byProject: [],
    byTag: { 'cost-center': [], project: [], env: [], owner: [] },
    backfill: [],
    backfillTruncated: false,
    notes,
  };
}
