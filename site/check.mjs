// Fails when the site's content has drifted from the design. No dependencies: node site/check.mjs
// Run after build.mjs (with the same SITE_BASE) so the link check can read site/dist.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const read = (f) => JSON.parse(readFileSync(join(here, 'content', f), 'utf8'));
const cast = read('cast.json'), contracts = read('contracts.json'), blueprints = read('blueprints.json');
const errors = [];
const fail = (m) => errors.push(m);

// 1. The cast is exactly the code's cast (SV1).
const types = readFileSync(join(repo, 'packages/contract/src/services/types.ts'), 'utf8');
const list = types.match(/FACTORY_SERVICE_NAMES\s*=\s*\[([\s\S]*?)\]\s*as const/);
const codeNames = list ? [...list[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
if (!codeNames.length) fail('could not read FACTORY_SERVICE_NAMES from packages/contract/src/services/types.ts');
const ids = cast.members.map((m) => m.id);
for (const n of codeNames) if (!ids.includes(n)) fail('cast member in code but not on the site: ' + n);
for (const i of ids) if (!codeNames.includes(i)) fail('cast member on the site but not in code: ' + i);
for (const m of cast.members) if (!cast.depts.includes(m.dept)) fail(m.id + ': unknown department ' + m.dept);
for (const [i, j] of cast.journey.entries()) if (!ids.includes(j[0])) fail('journey step ' + (i + 1) + ': unknown member ' + j[0]);

// 2. Contracts: both ends are members, the source file exists, and a flow uses it.
const cIds = new Set(contracts.map((c) => c.id));
const used = new Set();
for (const m of cast.members) for (const f of m.flows) for (const s of f.steps) {
  if (s.c) { used.add(s.c); if (!cIds.has(s.c)) fail(m.id + '/' + f.id + ': unknown contract ' + s.c); }
  if (s.to && !ids.includes(s.to)) fail(m.id + '/' + f.id + ': unknown member ' + s.to);
}
for (const c of contracts) {
  if (!ids.includes(c.from)) fail(c.id + ': unknown provider ' + c.from);
  for (const t of c.to) if (!ids.includes(t)) fail(c.id + ': unknown consumer ' + t);
  if (!existsSync(join(repo, c.src))) fail(c.id + ': source file does not exist: ' + c.src);
  if (!used.has(c.id)) fail(c.id + ': no flow uses this contract');
}

// 3. Blueprints: every member has exactly one row naming what serves it.
for (const [k, b] of Object.entries(blueprints)) {
  const rows = b.rows.map((r) => r[0]);
  for (const i of ids) if (!rows.includes(i)) fail(k + ': no row for ' + i);
  for (const r of b.rows) {
    if (!ids.includes(r[0])) fail(k + ': unknown member ' + r[0]);
    if (rows.filter((x) => x === r[0]).length > 1) fail(k + ': more than one row for ' + r[0]);
    if (r.length !== 2 || !r[1]) fail(k + '/' + r[0] + ': a row is [member, what serves it]');
  }
}

// 4. The site documents intent, not execution: no gap or task numbers, no roadmap or build status.
const INTENT = [/\b(GAP|TSK)-\d+/, /roadmap/i, /\bnot (yet )?(built|extracted|wired)\b/i, /\bcoming soon\b/i, /\bterraform\b/i];
for (const [file, text] of [['cast.json', JSON.stringify(cast)], ['contracts.json', JSON.stringify(contracts)], ['blueprints.json', JSON.stringify(blueprints)]]) {
  for (const re of INTENT) { const m = text.match(re); if (m) fail(file + ': execution detail in intent content: "' + m[0] + '"'); }
}

// 5. Every internal link in the built site resolves: to a page (a directory link ends in "/") and, when it has
// a fragment, to an id on that page. Links must sit under SITE_BASE.
const dist = join(here, 'dist');
const base = (process.env.SITE_BASE || '/').replace(/\/?$/, '/');
if (existsSync(dist)) {
  const files = [];
  (function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : files.push(p); } })(dist);
  const html = files.filter((x) => x.endsWith('.html'));
  const idsOf = new Map(html.map((f) => [f, new Set([...readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));
  for (const f of html) {
    const name = f.slice(dist.length);
    for (const m of readFileSync(f, 'utf8').matchAll(/(?:href|src)="([^"]*)"/g)) {
      const v = m[1];
      if (!v || /^(https?:|mailto:|\/\/)/.test(v)) continue;
      const [rawPath, frag] = v.split('#');
      if (!rawPath) { if (frag && !idsOf.get(f).has(frag)) fail(name + ': no id "' + frag + '" for link #' + frag); continue; }
      if (!rawPath.startsWith(base)) { fail(name + ': link is outside the site base ' + base + ': ' + v); continue; }
      const path = '/' + rawPath.slice(base.length);
      const last = path.split('/').pop();
      if (!path.endsWith('/') && !last.includes('.')) { fail(name + ': directory link needs a trailing slash: ' + v); continue; }
      const target = path.endsWith('/') ? join(dist, path, 'index.html') : join(dist, path);
      if (!existsSync(target)) { fail(name + ': broken link ' + v); continue; }
      if (frag && target.endsWith('.html') && !idsOf.get(target)?.has(frag)) fail(name + ': link ' + v + ' has no id "' + frag + '" on its page');
    }
  }
  // Fonts and other files the stylesheet loads, relative to it.
  for (const m of readFileSync(join(dist, 'styles.css'), 'utf8').matchAll(/url\('([^')]+)'\)/g)) {
    if (!/^(https?:|data:)/.test(m[1]) && !existsSync(join(dist, m[1]))) fail('styles.css: missing file ' + m[1]);
  }
} else {
  fail('site/dist is missing; run node site/build.mjs first');
}

if (errors.length) { console.error('site check failed:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log('site check ok: ' + ids.length + ' members, ' + contracts.length + ' contracts, ' + Object.keys(blueprints).length + ' blueprints');
