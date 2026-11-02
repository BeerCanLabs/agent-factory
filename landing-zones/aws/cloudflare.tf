# DESIGN_AUTHORITY.md §6.12 (A1, A2) & plans/factory-auth.md (D9, D18, D22, D23, S5b):
# Cloudflare edge configuration for the factory's public front door.
#
# Edge enforcement model when var.cloudflare_zone_id is set:
#   1. Root Access Application (`/*`) gates all paths by default (`decision = "allow"` for verified identities;
#      optional `decision = "non_identity"` for transitional service tokens per D9; never `everyone` or `bypass`).
#      Non-`fk_` traffic on `/api/v1*` and `/mcp` (keyless browsers, OAuth callbacks, `/ui` MCP sessions, future
#      factory session cookies, and transitional `CF-Access-Client-Id` service tokens) remains on `/*` so Cloudflare
#      Access verifies session cookies cryptographically and issues native `<team>.cloudflareaccess.com` redirects
#      preserving path and query string.
#   2. Webhook Access Application (`var.cloudflare_webhook_paths`, default `/api/v1/hooks/*`) bypasses interactive
#      Access for signature-verified webhook deliveries only (A1, D22, TSK-285, TSK-286).
#   3. Headless `fk_` API key bypass via internal edge prefix `/.cf-fk-bypass/*` (D9, D23, S5b):
#      - URL Rewrite (`http_request_transform`, after `http_request_sanitize` normalization and before Access) rewrites
#        `http.request.uri.path` to `concat("/.cf-fk-bypass", http.request.uri.path)` strictly when the request targets
#        canonical `/api/v1`, `/api/v1/*`, or `/mcp` (outside webhook paths, with no traversal) and carries a single
#        `Authorization: Bearer fk_<token>` header.
#      - WAF Custom Rule (`http_request_firewall_custom`, before Access) blocks (403) any direct or malformed request
#        under `/.cf-fk-bypass*` that is not a valid rewritten `/api/v1`, `/api/v1/*`, or `/mcp` `Bearer fk_<token>` call.
#      - Bypass Access Application (`/.cf-fk-bypass/*`) applies `decision = "bypass"` strictly to rewritten `fk_` calls.
#      - Request Header Transform (`http_request_late_transform`) strips client-supplied `cf-access-jwt-assertion`
#        and `cf-access-authenticated-user-email` headers on bypassed paths (A2).
#      - Post-Access Edge Worker (`${local.cloudflare_host}/.cf-fk-bypass/*`) strips the `/.cf-fk-bypass` prefix and
#        forwards the original `/api/v1`, `/api/v1/*`, or `/mcp` URI (with `cf-access-*` headers removed) to origin.

# Credentials come from CLOUDFLARE_API_TOKEN in the deploy environment; never stored in variables or state (K1, K5).
provider "cloudflare" {}

data "cloudflare_zone" "factory" {
  count   = local.cloudflare_enabled && var.cloudflare_account_id == "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
}

locals {
  cloudflare_enabled      = var.cloudflare_zone_id != ""
  cloudflare_account_id   = var.cloudflare_account_id != "" ? var.cloudflare_account_id : (local.cloudflare_enabled ? data.cloudflare_zone.factory[0].account.id : "")
  cloudflare_derived_host = lower(try(regex("^https://([A-Za-z0-9.-]+)(?::[0-9]+)?(?:/.*)?$", var.factory_public_base_url)[0], ""))
  cloudflare_host         = var.cloudflare_hostname != "" ? lower(var.cloudflare_hostname) : local.cloudflare_derived_host

  cloudflare_admin_emails = distinct(compact([for e in split(",", var.admin_emails) : lower(trimspace(e))]))
  cloudflare_allowed_emails = distinct(concat(
    [for e in var.cloudflare_access_allowed_emails : lower(trimspace(e))],
    local.cloudflare_admin_emails,
  ))

  cloudflare_root_allow_include = concat(
    [for d in var.cloudflare_access_allowed_email_domains : { email_domain = { domain = lower(trimspace(d)) } }],
    [for e in local.cloudflare_allowed_emails : { email = { email = e } }],
  )

  # External paths eligible to bypass interactive Access when carrying `Authorization: Bearer fk_<token>` (D9, D23, S5b).
  cloudflare_api_key_bypass_paths = [
    "/api/v1",
    "/api/v1/*",
    "/mcp",
  ]

  cloudflare_fk_bypass_prefix = "/.cf-fk-bypass"

  cloudflare_webhook_path_clauses = [
    for p in var.cloudflare_webhook_paths : (
      endswith(p, "/*")
      ? "starts_with(lower(http.request.uri.path), \"${lower(trimsuffix(p, "*"))}\")"
      : "lower(http.request.uri.path) eq \"${lower(p)}\""
    )
  ]
  cloudflare_webhook_path_expr = length(local.cloudflare_webhook_path_clauses) > 0 ? "(${join(" or ", local.cloudflare_webhook_path_clauses)})" : "false"

  cloudflare_rewritten_webhook_path_clauses = [
    for p in var.cloudflare_webhook_paths : (
      endswith(p, "/*")
      ? "starts_with(lower(http.request.uri.path), \"${local.cloudflare_fk_bypass_prefix}${lower(trimsuffix(p, "*"))}\")"
      : "lower(http.request.uri.path) eq \"${local.cloudflare_fk_bypass_prefix}${lower(p)}\""
    )
  ]
  cloudflare_rewritten_webhook_path_expr = length(local.cloudflare_rewritten_webhook_path_clauses) > 0 ? "(${join(" or ", local.cloudflare_rewritten_webhook_path_clauses)})" : "false"

  # Reject literal or percent-encoded dot-segments and encoded path separators even if URL normalization is relaxed.
  cloudflare_no_traversal_expr = "(not (http.request.uri.path contains \"..\") and not (lower(http.request.uri.path) contains \"%2e\") and not (lower(http.request.uri.path) contains \"%2f\") and not (lower(http.request.uri.path) contains \"%5c\"))"

  # Strict canonical path and `Bearer fk_<non-empty>` check (single Authorization header, non-empty secret suffix, no internal spaces).
  cloudflare_fk_canonical_path_expr = "((http.request.uri.path eq \"/api/v1\" or starts_with(http.request.uri.path, \"/api/v1/\") or http.request.uri.path eq \"/mcp\") and ${local.cloudflare_no_traversal_expr})"
  cloudflare_fk_bearer_expr         = "(len(http.request.headers[\"authorization\"]) eq 1 and starts_with(http.request.headers[\"authorization\"][0], \"Bearer fk_\") and len(trim(substring(http.request.headers[\"authorization\"][0], 7))) gt 3 and not (trim(substring(http.request.headers[\"authorization\"][0], 7)) contains \" \"))"
  cloudflare_fk_rewrite_expr        = "lower(http.host) eq \"${local.cloudflare_host}\" and ${local.cloudflare_fk_canonical_path_expr} and not ${local.cloudflare_webhook_path_expr} and ${local.cloudflare_fk_bearer_expr}"

  # Guard scope and invariant for the internal `/.cf-fk-bypass` namespace before Cloudflare Access evaluates destinations.
  cloudflare_fk_bypass_prefix_scope_expr = "lower(http.host) eq \"${local.cloudflare_host}\" and starts_with(lower(http.request.uri.path), \"/.cf-fk-bypass\")"
  cloudflare_fk_rewritten_valid_expr     = "((http.request.uri.path eq \"/.cf-fk-bypass/api/v1\" or starts_with(http.request.uri.path, \"/.cf-fk-bypass/api/v1/\") or http.request.uri.path eq \"/.cf-fk-bypass/mcp\") and ${local.cloudflare_no_traversal_expr} and not ${local.cloudflare_rewritten_webhook_path_expr} and ${local.cloudflare_fk_bearer_expr})"
  cloudflare_header_sanitize_scope_expr  = "lower(http.host) eq \"${local.cloudflare_host}\" and (starts_with(lower(http.request.uri.path), \"/.cf-fk-bypass\") or ${local.cloudflare_webhook_path_expr})"

  cloudflare_fk_strip_worker_js = <<-EOT
    const PREFIX = "/.cf-fk-bypass";
    export default {
      async fetch(request) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(PREFIX + "/")) {
          return new Response("Forbidden", { status: 403 });
        }
        const stripped = url.pathname.slice(PREFIX.length);
        const lower = stripped.toLowerCase();
        if (
          (stripped !== "/api/v1" && !stripped.startsWith("/api/v1/") && stripped !== "/mcp") ||
          stripped.includes("..") ||
          lower.includes("%2e") ||
          lower.includes("%2f") ||
          lower.includes("%5c")
        ) {
          return new Response("Forbidden", { status: 403 });
        }
        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer fk_") || auth.slice(10).trim().length === 0 || auth.slice(7).trim().includes(" ")) {
          return new Response("Forbidden", { status: 403 });
        }
        url.pathname = stripped;
        const rewritten = new Request(url.toString(), request);
        rewritten.headers.delete("cf-access-jwt-assertion");
        rewritten.headers.delete("cf-access-authenticated-user-email");
        return fetch(rewritten);
      },
    };
  EOT
}

# 1. Root Access Application: gates `/*` (including `/`, `/ui`, `/healthz`, `/metrics`, `/.well-known/*`,
#    and all non-`fk_` requests on `/api/v1*` and `/mcp`).
resource "cloudflare_zero_trust_access_application" "factory" {
  count            = local.cloudflare_enabled ? 1 : 0
  zone_id          = var.cloudflare_zone_id
  name             = "${local.name}-front-door"
  type             = "self_hosted"
  domain           = local.cloudflare_host
  session_duration = "24h"

  destinations = [
    {
      type = "public"
      uri  = "${local.cloudflare_host}/*"
    },
  ]

  policies = concat(
    [
      {
        name       = "allow-verified-identities"
        decision   = "allow"
        precedence = 1
        include    = local.cloudflare_root_allow_include
      },
    ],
    length(var.cloudflare_access_service_token_ids) > 0 ? [
      {
        name       = "transitional-service-tokens"
        decision   = "non_identity"
        precedence = 2
        include = [
          for id in var.cloudflare_access_service_token_ids : {
            service_token = {
              token_id = trimspace(id)
            }
          }
        ]
      },
    ] : [],
  )

  lifecycle {
    precondition {
      condition     = local.cloudflare_host != ""
      error_message = "cloudflare_hostname or a valid https:// factory_public_base_url is required when cloudflare_zone_id is set."
    }
    precondition {
      condition     = length(local.cloudflare_root_allow_include) > 0
      error_message = "At least one entry in cloudflare_access_allowed_email_domains, cloudflare_access_allowed_emails, or admin_emails is required when cloudflare_zone_id is set."
    }
  }
}

# 2. Signature-verified webhook bypass (`/api/v1/hooks/*` only; A1, D22, TSK-285, TSK-286).
resource "cloudflare_zero_trust_access_application" "webhooks_bypass" {
  count            = local.cloudflare_enabled && length(var.cloudflare_webhook_paths) > 0 ? 1 : 0
  zone_id          = var.cloudflare_zone_id
  name             = "${local.name}-webhooks-bypass"
  type             = "self_hosted"
  domain           = "${local.cloudflare_host}${var.cloudflare_webhook_paths[0]}"
  session_duration = "24h"

  destinations = [
    for p in var.cloudflare_webhook_paths : {
      type = "public"
      uri  = "${local.cloudflare_host}${p}"
    }
  ]

  policies = [
    {
      name       = "bypass-signature-verified-webhooks"
      decision   = "bypass"
      precedence = 1
      include = [
        {
          everyone = {}
        },
      ]
    },
  ]
}

# 3. Headless `fk_` API key bypass scoped strictly to the internal edge prefix `/.cf-fk-bypass/*` (D9, D23, S5b).
resource "cloudflare_zero_trust_access_application" "api_keys_bypass" {
  count            = local.cloudflare_enabled ? 1 : 0
  zone_id          = var.cloudflare_zone_id
  name             = "${local.name}-api-keys-bypass"
  type             = "self_hosted"
  domain           = "${local.cloudflare_host}/.cf-fk-bypass/*"
  session_duration = "24h"

  destinations = [
    {
      type = "public"
      uri  = "${local.cloudflare_host}/.cf-fk-bypass/*"
    },
  ]

  policies = [
    {
      name       = "bypass-fk-api-keys-via-internal-rewrite"
      decision   = "bypass"
      precedence = 1
      include = [
        {
          everyone = {}
        },
      ]
    },
  ]
}

# 4. Pre-Access URL rewrite (`http_request_transform`): rewrites canonical `/api/v1`, `/api/v1/*`, and `/mcp`
#    requests carrying `Authorization: Bearer fk_<token>` (outside webhook paths) onto `/.cf-fk-bypass/*`.
resource "cloudflare_ruleset" "api_keys_bypass_rewrite" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "${local.name}-api-keys-bypass-rewrite"
  description = "Rewrite canonical /api/v1 and /mcp Bearer fk_ requests onto /.cf-fk-bypass/* before Access (S5b)."
  kind        = "zone"
  phase       = "http_request_transform"

  rules = [
    {
      enabled     = true
      action      = "rewrite"
      description = "Route valid Bearer fk_ API and MCP requests through internal /.cf-fk-bypass prefix"
      expression  = local.cloudflare_fk_rewrite_expr
      action_parameters = {
        uri = {
          path = {
            expression = "concat(\"/.cf-fk-bypass\", http.request.uri.path)"
          }
        }
      }
    },
  ]
}

# 5. Pre-Access WAF guard (`http_request_firewall_custom`): blocks any direct or malformed request under
#    `/.cf-fk-bypass*` before Cloudflare Access evaluates `api_keys_bypass`.
resource "cloudflare_ruleset" "api_keys_bypass_guard" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "${local.name}-api-keys-bypass-guard"
  description = "Block any /.cf-fk-bypass* request that is not a valid rewritten /api/v1 or /mcp Bearer fk_ call (D9, D23, S5b)."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      enabled     = true
      action      = "block"
      description = "Refuse direct probes and non-fk_ credentials on /.cf-fk-bypass*"
      expression  = "(${local.cloudflare_fk_bypass_prefix_scope_expr}) and not (${local.cloudflare_fk_rewritten_valid_expr})"
    },
  ]
}

# 6. Post-Access header sanitization (`http_request_late_transform`): strip client-supplied Access headers on
#    bypassed paths so the origin never receives unstripped edge headers (A2).
resource "cloudflare_ruleset" "api_keys_header_sanitize" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "${local.name}-api-keys-header-sanitize"
  description = "Strip client-supplied Cloudflare Access headers on bypassed paths (A2)."
  kind        = "zone"
  phase       = "http_request_late_transform"

  rules = [
    {
      enabled     = true
      action      = "rewrite"
      description = "Remove client-supplied cf-access headers on bypassed API, MCP, and webhook paths"
      expression  = local.cloudflare_header_sanitize_scope_expr
      action_parameters = {
        headers = {
          "cf-access-jwt-assertion" = {
            operation = "remove"
          }
          "cf-access-authenticated-user-email" = {
            operation = "remove"
          }
        }
      }
    },
  ]
}

# 7. Post-Access Edge Worker: strips the internal `/.cf-fk-bypass` prefix after Cloudflare Access bypasses
#    interactive login so the origin receives the canonical `/api/v1`, `/api/v1/*`, or `/mcp` request URI.
resource "cloudflare_workers_script" "api_keys_bypass_strip" {
  count              = local.cloudflare_enabled ? 1 : 0
  account_id         = local.cloudflare_account_id
  script_name        = "${local.name}-fk-bypass-strip"
  main_module        = "worker.js"
  compatibility_date = "2026-01-01"
  content            = local.cloudflare_fk_strip_worker_js
}

resource "cloudflare_workers_route" "api_keys_bypass_strip" {
  count   = local.cloudflare_enabled ? 1 : 0
  zone_id = var.cloudflare_zone_id
  pattern = "${local.cloudflare_host}/.cf-fk-bypass/*"
  script  = cloudflare_workers_script.api_keys_bypass_strip[0].script_name
}
