// Page templates for the Beer Can Labs site. Every page is plain HTML with no script.
import { portrait } from './portrait.mjs';

export const REPO_URL = 'https://github.com/BeerCanLabs/agent-factory';
const BLOB = REPO_URL + '/blob/main/';

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function makeSite({ cast, contracts, blueprints, base = '/', siteUrl = 'https://beercanlabs.ai', commit = '' }) {
  const members = cast.members;
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const cById = Object.fromEntries(contracts.map((c) => [c.id, c]));
  const root = base.endsWith('/') ? base : base + '/';
  const url = {
    home: () => root,
    staff: () => root + 'staff/',
    member: (id, flow) => root + 'staff/' + id + '/' + (flow ? '#flow-' + flow : ''),
    contracts: () => root + 'contracts/',
    contract: (id) => root + 'contracts/' + id + '/',
    infra: () => root + 'infrastructure/',
    blueprint: (k) => root + 'infrastructure/' + k + '/',
  };
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];
  const countWord = WORDS[members.length] || String(members.length);
  const Count = countWord[0].toUpperCase() + countWord.slice(1);
  const uniq = (xs) => xs.filter((x, i, a) => a.indexOf(x) === i);

  const avatar = (id) => '<span class="av">' + portrait(byId[id], root) + '</span>';
  const personLink = (id) => '<a class="person-link" href="' + url.member(id) + '">' + esc(byId[id].name) + '</a>';

  function usedIn(cid) {
    const out = [], seen = new Set();
    for (const m of members) for (const f of m.flows) for (const s of f.steps) {
      if (s.c === cid && !seen.has(m.id + ':' + f.id)) { seen.add(m.id + ':' + f.id); out.push({ m, f }); }
    }
    return out;
  }

  /* ---------- views: each returns { title, description, body, nav } ---------- */
  function home() {
    const journey = cast.journey;
    const body =
      '<section class="hero"><div class="eyebrow">Agent Factory</div>' +
      '<h1>Just build the agent. <em>The factory is already built.</em></h1>' +
      '<p class="lead">Agent Factory is open-source, turnkey hosting for fleets of autonomous agents. You write the agent as a portable cartridge. The factory wakes it, keeps its keys, watches it, meters it and can switch it off, so you never build that part yourself.</p>' +
      '<div class="rule"><a class="btn" href="' + url.staff() + '">Meet the staff</a><a class="btn alt" href="' + url.infra() + '">See the blueprints</a><a class="btn alt" href="' + REPO_URL + '" rel="noopener">View the source</a></div></section>' +
      '<section class="sec-head"><div class="eyebrow">Why it exists</div><h2>Companies need three things to let AI do real work</h2></section>' +
      '<div class="needs"><div><span class="n">1</span><h3>Ease of creation</h3><p>Developers build a cartridge: a prompt, a manifest and some code. Push a pinned commit and the factory admits, builds and runs it.</p></div>' +
      '<div><span class="n">2</span><h3>Insight into value and cost</h3><p>Every model call is counted, priced and tied to an agent in real time, not on a bill that arrives a day late.</p></div>' +
      '<div><span class="n">3</span><h3>Protection from risk</h3><p>Agents hold no real secrets. Every outbound call passes the perimeter, and sensitive actions wait for a person.</p></div></div>' +
      '<section class="split"><div class="card"><div class="eyebrow">The factory</div><h2>The office building</h2><p>Compute, a locked-down front door, a safe for memory, a model service, a ledger. It looks the same whichever employee works in it, and whichever cloud it stands on.</p></div>' +
      '<div class="card ink"><div class="eyebrow" style="color:var(--panel-2)">The cartridge</div><h2>The employee</h2><p>Persona, instructions, skills, and its own notebook. What an agent decides, remembers and says is the cartridge’s business, never the factory’s.</p></div></section>' +
      '<section class="sec-head"><div class="eyebrow">A day in the life</div><h2>What happens when someone messages a sleeping agent</h2></section>' +
      '<ol class="journey">' + journey.map((x) => '<li><b>' + x[1] + '</b><span class="muted">' + x[2] + '</span><a href="' + url.member(x[0]) + '">' + avatar(x[0]) + '<span>' + esc(byId[x[0]].name) + '</span></a></li>').join('') + '</ol>' +
      '<section class="split"><div class="card"><h3>' + Count + ' staff, one rule</h3><p>Each member owns one job behind a typed contract. A change is either inside one member or on one contract between two. Read each member’s page for its key product flows and the contracts it keeps with the others.</p><a class="btn alt" href="' + url.contracts() + '" style="justify-self:start">All contracts</a></div>' +
      '<div class="card"><h3>Any cloud</h3><p>A blueprint maps each member to the services of one provider. AWS and GCP each have a blueprint. Nothing in the factory requires either.</p><a class="btn alt" href="' + url.infra() + '" style="justify-self:start">Infrastructure</a></div></section>';
    return { title: 'Beer Can Labs', description: 'Agent Factory is open-source, turnkey hosting for fleets of autonomous agents. Just build the agent; the factory is already built.', body, nav: 'home' };
  }

  function staff() {
    let h = '<section class="sec-head"><div class="eyebrow">Staff</div><h1>Meet the cast</h1><p class="lead">' + Count + ' staff run the factory. Each has one job, one package and one contract with everyone they work with.</p></section>';
    for (const d of cast.depts) {
      const ms = members.filter((m) => m.dept === d);
      h += '<section class="dept"><h2>' + esc(d) + ' <small>' + esc(cast.deptNotes[d]) + '</small></h2><div class="grid">' + ms.map((m) =>
        '<a class="person" href="' + url.member(m.id) + '"><div class="pic">' + portrait(m, root) + '</div><div class="info"><span class="title">' + esc(m.title) + '</span><h3>' + esc(m.name) + '</h3><p>' + esc(m.tag) + '</p><div class="chips"><span class="chip">' + m.flows.length + ' flows</span></div></div></a>').join('') + '</div></section>';
    }
    return { title: 'Staff | Beer Can Labs', description: 'The ' + countWord + ' members of the Agent Factory cast: what each does, its key product flows and its contracts.', body: h, nav: 'staff' };
  }

  function member(m) {
    let h = '<div class="crumbs"><a href="' + url.staff() + '">Staff</a> / ' + esc(m.name) + '</div>' +
      '<section class="profile"><div class="pic">' + portrait(m, root) + '</div><div class="who"><div class="eyebrow">' + esc(m.dept) + '</div><h1>' + esc(m.name) + '</h1><div><span class="eyebrow" style="color:var(--accent)">' + esc(m.title) + '</span></div><p class="lead">' + esc(m.bio) + '</p></div></section>' +
      '<dl class="facts"><div><dt>Design rules</dt><dd>' + esc(m.rules) + '</dd></div><div><dt>Contracts offered</dt><dd>' + (contracts.filter((c) => c.from === m.id).length || 'None') + '</dd></div><div><dt>Key flows</dt><dd>' + m.flows.length + '</dd></div></dl>' +
      '<section class="two"><div class="card"><h3>On the job</h3><ul>' + m.does.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div><div class="card"><h3>Not my job</h3><ul>' + m.dont.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div></section>' +
      '<section class="sec-head"><div class="eyebrow">Key product flows</div><h2>What ' + esc(m.name) + ' does, step by step</h2><nav class="toc" aria-label="Flows">' + m.flows.map((f) => '<a href="#flow-' + f.id + '">' + esc(f.name) + '</a>').join('') + '</nav></section>';
    for (const f of m.flows) {
      h += '<section class="flow" id="flow-' + f.id + '"><header><div class="eyebrow">Flow</div><h2>' + esc(f.name) + '</h2><p class="muted">' + esc(f.intro) + '</p></header><ol>' + f.steps.map((s) => {
        let c = '';
        if (s.c) {
          const ct = cById[s.c], other = s.to || ct.from;
          c = '<div class="callout">' + (other === m.id ? '<span class="muted">Contract</span>' : avatar(other) + '<span>Works with ' + personLink(other) + '</span><span class="muted">· contract</span>') + '<a class="contract-link" href="' + url.contract(ct.id) + '">' + esc(ct.name) + ' →</a>' + (s.why ? '<span class="why">' + esc(s.why) + '</span>' : '') + '</div>';
        }
        return '<li><div><p>' + esc(s.t) + '</p>' + c + '</div></li>';
      }).join('') + '</ol></section>';
    }
    const kept = contracts.filter((c) => c.from === m.id);
    h += '<section class="dept"><h2>Contracts ' + esc(m.name) + ' keeps <small>' + kept.length + ' offered</small></h2>' +
      (kept.length ? '<ul class="list">' + kept.map((c) => '<li><a href="' + url.contract(c.id) + '">' + esc(c.name) + '</a><span class="muted">used by ' + uniq(c.to).map((x) => esc(byId[x].name)).join(', ') + '</span></li>').join('') + '</ul>' : '<p class="muted">None offered separately.</p>') + '</section>';
    return { title: m.name + ' | Beer Can Labs', description: m.title + '. ' + m.tag, body: h, nav: 'staff' };
  }

  function contract(c) {
    const to = uniq(c.to);
    let h = '<div class="crumbs"><a href="' + url.contracts() + '">Contracts</a> / ' + esc(c.name) + '</div><section class="sec-head"><div class="eyebrow">Contract</div><h1 style="font-size:clamp(1.8rem,4.6vw,3rem)">' + esc(c.name) + '</h1></section>' +
      '<div class="between"><a class="pill" href="' + url.member(c.from) + '">' + avatar(c.from) + esc(byId[c.from].name) + '</a><span class="arrow" aria-hidden="true">→</span>' + to.map((x) => '<a class="pill" href="' + url.member(x) + '">' + avatar(x) + esc(byId[x].name) + '</a>').join('') + '</div>' +
      '<p class="lead">' + esc(c.what) + '</p>' +
      '<section class="dept"><h2>Signature</h2><pre class="sig">' + esc(c.sig) + '</pre><p><a href="' + BLOB + c.src + '" rel="noopener" class="mono">' + esc(c.src) + ' ↗</a></p></section>' +
      '<section class="dept"><h2>Rules</h2><ul class="list">' + c.rules.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul></section>' +
      '<section class="dept"><h2>Where it appears</h2><ul class="list">' + usedIn(c.id).map((x) => '<li><a href="' + url.member(x.m.id, x.f.id) + '">' + esc(x.f.name) + '</a><span class="muted">' + esc(x.m.name) + '</span></li>').join('') + '</ul></section>';
    return { title: c.name + ' | Contracts | Beer Can Labs', description: c.what, body: h, nav: 'staff' };
  }

  function contractIndex() {
    const body = '<section class="sec-head"><div class="eyebrow">Contracts</div><h1>Who talks to whom</h1><p class="lead">Members talk to each other only through typed contracts wired into real call sites. No member reads another’s files or tables.</p></section><div class="ctab">' +
      contracts.map((c) => '<div class="crow"><div><a class="mono" href="' + url.contract(c.id) + '"><b>' + esc(c.name) + '</b></a><div class="muted" style="font-size:.85rem">' + esc(c.src) + '</div></div><div><a href="' + url.member(c.from) + '"><b>' + esc(byId[c.from].name) + '</b></a> → ' + uniq(c.to).map((x) => '<a href="' + url.member(x) + '">' + esc(byId[x].name) + '</a>').join(', ') + '</div><div class="muted">' + esc(c.what) + '</div></div>').join('') + '</div>';
    return { title: 'Contracts | Beer Can Labs', description: 'Every typed contract between Agent Factory cast members.', body, nav: 'staff' };
  }

  function infra() {
    const body = '<section class="sec-head"><div class="eyebrow">Infrastructure</div><h1>Blueprints</h1><p class="lead">A blueprint maps each member of the cast to the services of one cloud provider. Each provider is its own blueprint. The factory does not depend on any of them.</p></section><div class="bp-cards">' +
      Object.entries(blueprints).map(([k, b]) => '<a class="bp ' + k + '" href="' + url.blueprint(k) + '"><span class="mark">' + esc(b.mark) + '</span><h2>' + esc(b.pattern) + '</h2><p>' + esc(b.blurb) + '</p></a>').join('') + '</div>';
    return { title: 'Infrastructure | Beer Can Labs', description: 'Agent Factory blueprints: each cast member mapped to the services of a cloud provider.', body, nav: 'infra' };
  }

  function blueprint(k) {
    const b = blueprints[k];
    const body = '<div class="crumbs"><a href="' + url.infra() + '">Infrastructure</a> / ' + esc(b.name) + '</div><section class="sec-head"><div class="eyebrow">Blueprint</div><h1>' + esc(b.name) + ': ' + esc(b.pattern) + '</h1><p class="lead">' + esc(b.blurb) + '</p></section>' +
      '<div class="tablewrap"><table><thead><tr><th>Cast member</th><th>What serves it on ' + esc(b.name) + '</th></tr></thead><tbody>' + b.rows.map((r) =>
        '<tr><td class="member"><a href="' + url.member(r[0]) + '">' + avatar(r[0]) + esc(byId[r[0]].name) + '</a></td><td><span class="svc">' + esc(r[1]) + '</span></td></tr>').join('') + '</tbody></table></div>';
    return { title: b.name + ' blueprint | Beer Can Labs', description: b.blurb, body, nav: 'infra' };
  }


  function notFound() {
    return { title: 'Not found | Beer Can Labs', description: 'That page does not exist.', nav: '', body: '<section class="hero"><div class="eyebrow">404</div><h1>That page is not here.</h1><p class="lead">It may have moved. Start from the home page, the staff or the blueprints.</p><div class="rule"><a class="btn" href="' + url.home() + '">Home</a><a class="btn alt" href="' + url.staff() + '">Staff</a></div></section>' };
  }

  /* ---------- shell ---------- */
  const NAV = [['home', 'Home', url.home()], ['staff', 'Staff', url.staff()], ['infra', 'Infrastructure', url.infra()]];

  function shell(page, path) {
    const canonical = siteUrl + path;
    return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
      '<title>' + esc(page.title) + '</title><meta name="description" content="' + esc(page.description) + '">' +
      '<link rel="canonical" href="' + esc(canonical) + '"><meta property="og:title" content="' + esc(page.title) + '"><meta property="og:description" content="' + esc(page.description) + '"><meta property="og:type" content="website"><meta property="og:url" content="' + esc(canonical) + '">' +
      '<meta name="color-scheme" content="light dark"><link rel="icon" href="' + root + 'favicon.svg" type="image/svg+xml">' +
      '<link rel="stylesheet" href="' + root + 'styles.css"></head><body>' +
      '<div class="top"><div class="wrap"><a class="brand" href="' + url.home() + '" aria-label="Beer Can Labs home"><svg viewBox="0 0 26 34" aria-hidden="true"><rect x="2" y="4" width="22" height="27" rx="3" fill="var(--accent)"/><rect x="2" y="1" width="22" height="4" rx="1.5" fill="var(--ink)"/><rect x="2" y="30" width="22" height="3" rx="1.5" fill="var(--ink)"/><rect x="6" y="12" width="14" height="9" fill="var(--bg)"/><path d="M9 17h8M13 14v6" stroke="var(--ink)" stroke-width="1.6"/></svg>Beer Can Labs</a>' +
      '<nav aria-label="Main">' + NAV.map((n) => '<a href="' + n[2] + '"' + (n[0] === page.nav ? ' aria-current="page"' : '') + '>' + n[1] + '</a>').join('') + '</nav></div></div>' +
      '<div class="wrap"><main id="app">' + page.body + '</main></div>' +
      '<footer><div class="wrap"><div><b>Beer Can Labs</b> · <a href="' + REPO_URL + '" rel="noopener">BeerCanLabs/agent-factory</a>' + '</div>' +
      '<div>This site documents the intent of the Agent Factory design.</div></div></footer></body></html>\n';
  }

  /** Every page of the site: [path, page]. */
  function pages() {
    const out = [['/', home()], ['/staff/', staff()], ['/contracts/', contractIndex()], ['/infrastructure/', infra()]];
    for (const m of members) out.push(['/staff/' + m.id + '/', member(m)]);
    for (const c of contracts) out.push(['/contracts/' + c.id + '/', contract(c)]);
    for (const k of Object.keys(blueprints)) out.push(['/infrastructure/' + k + '/', blueprint(k)]);
    return out;
  }

  return { pages, shell, notFound, url };
}
