// Page templates for the Beer Can Labs site. Every page is plain HTML with no script.
import { portrait } from './portrait.mjs';

export const REPO_URL = 'https://github.com/BeerCanLabs/agent-factory';
const BLOB = REPO_URL + '/blob/main/';

export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

export function makeSite({ cast, contracts, blueprints, house = { intro: '', members: [] }, base = '/', siteUrl = 'https://beercanlabs.ai', commit = '' }) {
  const members = cast.members;
  const byId = Object.fromEntries(members.map((m) => [m.id, m]));
  const cById = Object.fromEntries(contracts.map((c) => [c.id, c]));
  const root = base.endsWith('/') ? base : base + '/';
  const url = {
    home: () => root,
    build: () => root + 'build/',
    staff: () => root + 'staff/',
    adopt: () => root + 'adopt/',
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
      '<div class="rule"><a class="btn" href="' + url.build() + '">Build an agent</a><a class="btn alt" href="' + url.staff() + '">Meet the staff</a><a class="btn alt" href="' + url.infra() + '">See the blueprints</a><a class="btn alt" href="' + REPO_URL + '" rel="noopener">View the source</a></div></section>' +
      '<section class="sec-head"><div class="eyebrow">Why it exists</div><h2>Companies need three things to let AI do real work</h2></section>' +
      '<div class="needs"><div><span class="n">1</span><h3>Ease of creation</h3><p>Build an employee in two ways: define a configuration-only agent with a persona, memory archetype and reusable skills on the shared runtime, or push a pinned commit from a cartridge repository when custom code or a custom container is needed. <a href="' + url.build() + '">See how agents are built →</a></p></div>' +
      '<div><span class="n">2</span><h3>Insight into value and cost</h3><p>Every model call is counted, priced and tied to an agent in real time, not on a bill that arrives a day late.</p></div>' +
      '<div><span class="n">3</span><h3>Protection from risk</h3><p>Agents hold no real secrets. Every outbound call passes the perimeter, and sensitive actions wait for a person.</p></div></div>' +
      '<section class="split"><div class="card"><div class="eyebrow">The factory</div><h2>The office building</h2><p>Compute, a locked-down front door, a safe for memory, a model service, a ledger. It looks the same whichever employee works in it, and whichever cloud it stands on.</p></div>' +
      '<div class="card ink"><div class="eyebrow" style="color:var(--panel-2)">The cartridge</div><h2>The employee</h2><p>Persona, instructions, skills, and its own notebook—hosted either as a pure configuration on the shared runtime or as a dedicated container repository. What an agent decides, remembers and says is the employee’s business, never the factory’s.</p></div></section>' +
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
    h += '<section class="dept"><h2>House staff <small>optional agents that ship with the factory</small></h2><p class="muted">' + esc(house.intro) + '</p><div class="grid">' +
      house.members.map((m) => '<a class="person" href="' + url.member(m.id) + '"><div class="pic"><img src="' + root + 'house/' + m.id + '.png" alt="Portrait of the ' + esc(m.name) + '" width="512" height="512"></div><div class="info"><span class="title">' + esc(m.title) + '</span><h3>' + esc(m.name) + '</h3><p>' + esc(m.tag) + '</p></div></a>').join('') +
      '</div></section>';
    return { title: 'Staff | Beer Can Labs', description: 'The ' + countWord + ' members of the Agent Factory cast, plus the optional house staff.', body: h, nav: 'staff' };
  }

  function houseMember(m) {
    let h = '<div class="crumbs"><a href="' + url.staff() + '">Staff</a> / ' + esc(m.name) + '</div>' +
      '<section class="profile"><div class="pic"><img src="' + root + 'house/' + m.id + '.png" alt="Portrait of the ' + esc(m.name) + '" width="512" height="512"></div><div class="who"><div class="eyebrow">House staff</div><h1>' + esc(m.name) + '</h1><div><span class="eyebrow" style="color:var(--accent)">' + esc(m.title) + '</span></div><p class="lead">' + esc(m.bio) + '</p></div></section>' +
      '<section class="two"><div class="card"><h3>On the job</h3><ul>' + m.does.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div><div class="card"><h3>Not my job</h3><ul>' + m.dont.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div></section>';
    return { title: m.name + ' | Beer Can Labs', description: m.title + '. ' + m.tag, body: h, nav: 'staff' };
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


  function build() {
    const body =
      '<section class="sec-head"><div class="eyebrow">Dual-Mode Hosting</div><h1>Two ways to build an employee</h1>' +
      '<p class="lead">Every agent in the factory lives inside the same perimeter, draws from a metered budget, keeps its notebook in the safe, and passes an activation smoke check before going live. You choose how much you want to own: a declarative configuration on the shared runtime, or a dedicated repository in its own container.</p></section>' +
      '<section class="split">' +
      '<div class="card"><div class="eyebrow">Default Track · Shared Runtime</div><h2>Configuration-Only Agent</h2>' +
      '<p>For most assistants, analysts, and workflow automatons, no git repository or container build is needed. You define the agent as pure configuration running on the factory’s shared agent runtime:</p>' +
      '<ul>' +
      '<li><b>Persona (Soul):</b> Write the instructions, tone, and boundaries that define who the employee is.</li>' +
      '<li><b>Memory Archetype:</b> Choose <i>purpose-built</i> (stateless task worker), <i>personal assistant</i> (per-person notebook), or <i>team member</i> (shared project workspace).</li>' +
      '<li><b>Composable Skills:</b> Attach reusable Python skill packages checked offline by the ' + personLink('registrar') + '.</li>' +
      '<li><b>Fleet-Wide Upgrades:</b> Approve a new shared runtime digest once and the factory smoke-tests and upgrades every configuration agent automatically.</li>' +
      '<li><b>Portable Bundle:</b> Export the entire agent configuration as a single bundle and import it into any factory.</li>' +
      '</ul></div>' +
      '<div class="card ink"><div class="eyebrow" style="color:var(--panel-2)">Full Control · Custom Container</div><h2>Repository Cartridge</h2>' +
      '<p>When an employee needs custom execution logic or specialized runtime dependencies beyond the shared loop, build a self-contained repository cartridge:</p>' +
      '<ul>' +
      '<li><b>Custom Execution Loops:</b> Implement bespoke multi-step state machines, custom context assembly, or specialized reasoning pipelines.</li>' +
      '<li><b>Any Language or Binary:</b> Write the cartridge in Python, TypeScript, Go, or Rust, or bundle compiled native libraries and command-line tools.</li>' +
      '<li><b>Custom Domain Schemas:</b> Maintain specialized local SQLite tables and indexing pipelines inside the agent’s notebook directory.</li>' +
      '<li><b>House Staff &amp; Platform Tools:</b> Power privileged factory house staff and custom engineering workflows admitted from a pinned commit.</li>' +
      '</ul></div></section>' +
      '<section class="sec-head"><div class="eyebrow">Decision Guide</div><h2>When to choose each model</h2>' +
      '<p class="muted">Both models are governed by the same ' + countWord + ' cast members and pass the same activation smoke gate before taking traffic.</p></section>' +
      '<div class="tablewrap"><table><thead><tr><th>Dimension</th><th>Configuration-Only Agent</th><th>Repository Cartridge</th></tr></thead><tbody>' +
      '<tr><td><b>What you author</b></td><td>Persona, memory archetype, caller roles, and adopted skill packages.</td><td>Git repository with manifest, persona, source code, unit tests, and Dockerfile.</td></tr>' +
      '<tr><td><b>Creation &amp; updates</b></td><td>Instant via API or conversationally with the Agent Builder; updates version in place.</td><td>Push a 40-character commit SHA; admitted through offline secret scan, test run, and image build.</td></tr>' +
      '<tr><td><b>Tooling &amp; dependencies</b></td><td>Modular Python standard-library and vendored pure-Python skill packages shared across the fleet.</td><td>Any language, runtime, or compiled binary tool (never cloud or model provider SDKs).</td></tr>' +
      '<tr><td><b>Runtime maintenance</b></td><td>One admin-approved runtime rollout upgrades and smoke-tests the fleet with automatic rollback.</td><td>Repository owner maintains the base image, dependencies, and turn loop.</td></tr>' +
      '<tr><td><b>Portability</b></td><td>Self-contained configuration bundle export and import across factories.</td><td>Git repository and container image; can also be converted in place to a configuration agent.</td></tr>' +
      '</tbody></table></div>' +
      '<section class="sec-head"><div class="eyebrow">Lifecycle</div><h2>From idea to sleeping employee</h2></section>' +
      '<section class="split">' +
      '<div class="card"><div class="eyebrow">Track A</div><h3>Building a Configuration-Only Agent</h3>' +
      '<ol>' +
      '<li><b>Define persona &amp; memory:</b> Author the soul and select the memory archetype (purpose-built, personal assistant, or team member).</li>' +
      '<li><b>Adopt skills:</b> Pick approved skills from the catalog, or package and register new Python skills verified offline by the ' + personLink('registrar') + '.</li>' +
      '<li><b>Create &amp; set policy:</b> Create the agent via the API or Agent Builder, then have an administrator grant its models, routes, and budget with the ' + personLink('accountant') + ' and ' + personLink('gatekeeper') + '.</li>' +
      '<li><b>Smoke test &amp; sleep:</b> Deploy the agent. The ' + personLink('property-manager') + ' runs an activation smoke check—verifying a model turn and every adopted skill—before putting the agent to sleep ready for work.</li>' +
      '</ol></div>' +
      '<div class="card"><div class="eyebrow">Track B</div><h3>Building a Repository Cartridge</h3>' +
      '<ol>' +
      '<li><b>Scaffold the cartridge:</b> Write the soul, manifest, turn loop, Dockerfile, and unit tests against the factory model API and local notebook directory.</li>' +
      '<li><b>Admit a pinned commit:</b> Register the commit SHA. The ' + personLink('registrar') + ' and ' + personLink('property-manager') + ' scan for hardcoded secrets, run the test suite, and build the container image.</li>' +
      '<li><b>Bind policy &amp; credentials:</b> Bind required secret names with the ' + personLink('keymaster') + ' and grant models, routes, and budget limits.</li>' +
      '<li><b>Smoke test &amp; sleep:</b> Deploy the admitted image through the activation smoke gate. If a cartridge later simplifies to standard skills, convert it in place to a configuration agent without losing its identity, ledger history, or memory.</li>' +
      '</ol></div></section>' +
      '<section class="hero" style="margin-top:2rem"><div class="eyebrow">Developer Guides</div>' +
      '<h2>Read the full specifications</h2>' +
      '<p class="lead">Explore the step-by-step guides for creating configuration agents, packaging reusable skills, and authoring custom cartridges.</p>' +
      '<div class="rule"><a class="btn" href="' + BLOB + 'docs/CREATING_AGENTS.md" rel="noopener">Creating Agents Guide ↗</a><a class="btn alt" href="' + BLOB + 'docs/SKILLS.md" rel="noopener">Skills Guide ↗</a><a class="btn alt" href="' + BLOB + 'docs/CARTRIDGE_DEVELOPER_GUIDE.md" rel="noopener">Cartridge Developer Guide ↗</a></div></section>';
    return { title: 'Build an Agent | Beer Can Labs', description: 'Two ways to build an autonomous agent on Agent Factory: configuration-only agents on the shared runtime, or repository cartridges in their own container.', body, nav: 'build' };
  }

  function adopt() {
    const body =
      '<section class="sec-head"><div class="eyebrow">For Non-Profits</div><h1>Autonomous Agent Factory for Social Impact</h1>' +
      '<p class="lead">BeerCanLabs provides open-source, royalty-free agent infrastructure designed specifically for non-profit organizations with low or no dedicated IT staff.</p></section>' +
      '<section class="split">' +
      '<div class="card"><div class="eyebrow">Real Non-Profit Impact</div><h2>How agents help small teams</h2>' +
      '<p>Small non-profits face endless administrative tasks. Our specialized agents automate toil without requiring coding knowledge:</p>' +
      '<ul>' +
      '<li><b>Donor Stewardship:</b> Draft personalized acknowledgement letters and annual giving updates.</li>' +
      '<li><b>Volunteer Coordination:</b> Process volunteer applications, send briefings, and coordinate schedules.</li>' +
      '<li><b>Grant Research:</b> Cross-reference program documentation against RFP requirements.</li>' +
      '<li><b>Board & Operations:</b> Prepare meeting agendas, meeting minutes, and operational summaries.</li>' +
      '</ul></div>' +
      '<div class="card ink"><div class="eyebrow" style="color:var(--panel-2)">Predictable FinOps</div><h2>Zero budget surprises ($10–$50/mo)</h2>' +
      '<p>Non-profits cannot afford runaway cloud bills. The factory was built from day one with automated financial safeguards:</p>' +
      '<ul>' +
      '<li><b>Scale to Zero:</b> Cloud Run compute turns off when agents are not running. You pay only for active seconds.</li>' +
      '<li><b>Hard Monthly Dollar Caps:</b> Each agent has a monthly budget ceiling. If reached, it sleeps automatically. Overdraft is physically impossible.</li>' +
      '<li><b>Efficient Models:</b> Optimized for economical, high-intelligence models costing pennies per day.</li>' +
      '</ul></div></section>' +
      '<section class="split">' +
      '<div class="card"><div class="eyebrow">Low-IT Deployment</div><h2>1-Click Cloud Deployment</h2>' +
      '<p>You do not need an infrastructure team to run the factory. Adopters deploy directly into their own Google Cloud or AWS accounts:</p>' +
      '<ol>' +
      '<li>Click the deployment template for Google Cloud Run or AWS.</li>' +
      '<li>Set your administrator email and model provider API key.</li>' +
      '<li>Log in to the web console and begin activating your agents.</li>' +
      '</ol>' +
      '<p>Visit the <a href="' + url.infra() + '">infrastructure blueprints</a> to see how each service maps cleanly to your cloud.</p></div>' +
      '<div class="card"><div class="eyebrow">Data Privacy & Sovereignty</div><h2>Your donor data stays yours</h2>' +
      '<p>Trust is everything for a non-profit. The Agent Factory enforces strict data boundaries:</p>' +
      '<ul>' +
      '<li><b>Self-Hosted & Private:</b> All data, databases, and conversation records stay inside your own cloud account.</li>' +
      '<li><b>Zero Training:</b> Standard configurations use commercial API endpoints that never use your data for model training.</li>' +
      '<li><b>Credential Isolation:</b> Secret keys are held in secure cloud vaults and never exposed to the agents themselves.</li>' +
      '</ul></div></section>' +
      '<section class="hero" style="margin-top:2rem"><div class="eyebrow">Open Source & Royalty-Free</div>' +
      '<h2>Ready to explore the factory?</h2>' +
      '<p class="lead">Review the cast of factory services or inspect the full open-source codebase.</p>' +
      '<div class="rule"><a class="btn" href="' + url.staff() + '">Meet the staff</a><a class="btn alt" href="' + url.infra() + '">Cloud blueprints</a><a class="btn alt" href="' + REPO_URL + '" rel="noopener">GitHub repository</a></div></section>';
    return { title: 'For Non-Profits | Beer Can Labs', description: 'Open-source, royalty-free agent hosting for non-profits with low IT skills and strict budget controls.', body, nav: 'adopt' };
  }

  function notFound() {
    return { title: 'Not found | Beer Can Labs', description: 'That page does not exist.', nav: '', body: '<section class="hero"><div class="eyebrow">404</div><h1>That page is not here.</h1><p class="lead">It may have moved. Start from the home page, the staff or the blueprints.</p><div class="rule"><a class="btn" href="' + url.home() + '">Home</a><a class="btn alt" href="' + url.staff() + '">Staff</a></div></section>' };
  }

  /* ---------- shell ---------- */
  const NAV = [['home', 'Home', url.home()], ['build', 'Build an Agent', url.build()], ['staff', 'Staff', url.staff()], ['adopt', 'For Non-Profits', url.adopt()], ['infra', 'Infrastructure', url.infra()]];

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
    const out = [['/', home()], ['/build/', build()], ['/staff/', staff()], ['/adopt/', adopt()], ['/contracts/', contractIndex()], ['/infrastructure/', infra()]];
    for (const m of members) out.push(['/staff/' + m.id + '/', member(m)]);
    for (const m of house.members) out.push(['/staff/' + m.id + '/', houseMember(m)]);
    for (const c of contracts) out.push(['/contracts/' + c.id + '/', contract(c)]);
    for (const k of Object.keys(blueprints)) out.push(['/infrastructure/' + k + '/', blueprint(k)]);
    return out;
  }

  return { pages, shell, notFound, url };
}
