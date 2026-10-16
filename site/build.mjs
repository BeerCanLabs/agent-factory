// Builds the Beer Can Labs site into site/dist. No dependencies: node site/build.mjs
// SITE_BASE (default "/") is the path prefix; SITE_URL (default https://beercanlabs.ai) is the canonical origin.
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSite } from './lib/render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(readFileSync(join(here, 'content', f), 'utf8'));
const dist = join(here, 'dist');
const base = process.env.SITE_BASE || '/';
const siteUrl = (process.env.SITE_URL || 'https://beercanlabs.ai').replace(/\/$/, '');

const site = makeSite({
  cast: read('cast.json'), contracts: read('contracts.json'), blueprints: read('blueprints.json'),
  house: read('house.json'),
  base, siteUrl, commit: process.env.GITHUB_SHA || '',
});

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const put = (rel, body) => { const f = join(dist, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, body); };

const pages = site.pages();
for (const [path, page] of pages) put(path.slice(1) + 'index.html', site.shell(page, path));
put('404.html', site.shell(site.notFound(), '/404.html'));
put('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + pages.map(([p]) => '  <url><loc>' + siteUrl + p + '</loc></url>').join('\n') + '\n</urlset>\n');
put('robots.txt', 'User-agent: *\nAllow: /\nSitemap: ' + siteUrl + '/sitemap.xml\n');
cpSync(join(here, 'styles.css'), join(dist, 'styles.css'));
cpSync(join(here, 'static'), dist, { recursive: true });

console.log('site: built ' + (pages.length + 1) + ' pages into site/dist');
