# Beer Can Labs site

The public site at <https://beercanlabs.ai>: the Agent Factory's purpose, the staff (the cast), a page for every
contract between them, and one infrastructure blueprint per cloud provider. It documents **intent**, not how or whether
something is built: no package names, build status, gap or task numbers, or Terraform files. It is static HTML built from
files in this repository (GAP-135, TSK-195). There is no script on any page.

## Edit it

| To change | Edit |
|---|---|
| A cast member's bio or flows | `content/cast.json` |
| Optional house staff (not a cast member) | `content/house.json` and `static/house/` |
| A cast member's portrait | `static/cast/<id>.png` |
| A contract between two members | `content/contracts.json` |
| What serves each member on a provider | `content/blueprints.json` |
| Layout and copy of the pages | `lib/render.mjs`, `styles.css` |

```sh
SITE_BASE=/ node site/build.mjs         # writes site/dist (SITE_BASE defaults to /)
node site/check.mjs                     # fails if the site has drifted from the code
(cd site/dist && python3 -m http.server 8000)   # preview at http://localhost:8000
```

`check.mjs` fails when the cast differs from `FACTORY_SERVICE_NAMES` in `packages/contract`, when a contract's source
file does not exist, when a contract is used by no flow, when a blueprint lacks a row for a member, when a built link
is broken, and when the content carries execution detail (gap or task numbers, roadmap or build status, Terraform).

`site/` is not an npm workspace; it has no dependencies. Fonts are self-hosted in `static/fonts/` (SIL Open Font
License, see `LICENSES.txt`), so a visitor's browser contacts no third party.

## Publish

`.github/workflows/site.yml` builds and checks on a pull request that touches `site/` or any package (the check reads the cast's definition and
each contract's source file), and deploys to GitHub Pages when such a change merges to `main`.

### One-time setup (needs repository admin and the Cloudflare account)

1. **GitHub:** Settings, Pages, Build and deployment, Source: **GitHub Actions**. Then set the custom domain to
   `beercanlabs.ai` and, once the certificate is issued, tick **Enforce HTTPS**. The domain is bound by this
   setting; there is no `CNAME` file in the repository (an Actions deployment ignores one). Until it is set the site
   is served from the `github.io` project path, where the root-relative links break.
2. **GitHub, recommended:** verify the domain for the organization (Settings, Pages, Add a domain) so no one else can
   claim it. It asks for one TXT record.
3. **Cloudflare, `beercanlabs.ai`**, DNS records, all set to **DNS only** (grey cloud) so GitHub can issue the certificate:

   | Type | Name | Content |
   |---|---|---|
   | A | `@` | `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (four records) |
   | AAAA | `@` | `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153` (four records) |
   | CNAME | `www` | `beercanlabs.github.io` |

4. **Cloudflare, `beercanlabs.com`:** add a proxied (orange cloud) `A` record for `@` and `www` pointing at the
   placeholder address `192.0.2.1`, then a Redirect Rule: when the hostname is `beercanlabs.com` or
   `www.beercanlabs.com`, redirect with status 301 to `concat("https://beercanlabs.ai", http.request.uri.path)`,
   preserving the query string.
5. Run the workflow once from the Actions tab (`site`, Run workflow) and open the site.

No credentials are stored in this repository. The DNS records and the Pages setting live in those providers' settings
(CLAUDE.md §1).
