# DESIGN_AUTHORITY.md §6.12 (A1, A2) & plans/factory-auth.md (D9, D18, D22, D23, S5b):
# Cloudflare edge configuration for the factory's public front door.
#
# Edge enforcement model when var.cloudflare_zone_id is set:
#   1. Root Access Application (`/*`) gates all paths by default (`decision = "allow"` for verified identities;
#      optional `decision = "service_auth"` for transitional service tokens per D9; never `everyone` or `bypass`).
#   2. Webhook Access Application (`var.cloudflare_webhook_paths`, default `/api/v1/hooks/*`) bypasses interactive
#      Access for signature-verified webhook deliveries only (A1, D22, TSK-285, TSK-286).
#   3. API-key Access Application (`/api/v1`, `/api/v1/*`, `/mcp`) is paired with pre-Access edge rulesets:
#      - Keyless unauthenticated requests on `/api/v1*` and `/mcp*` (outside webhook paths) redirect (302) to
#        `https://<host>/cdn-cgi/access/login` (`http_request_dynamic_redirect`, S5b).
#      - WAF Custom Rule (`http_request_firewall_custom`) blocks (403) any request on `/api/v1*` and `/mcp*`
#        (outside webhook paths) unless it presents a single `Authorization: Bearer fk_<token>` header on canonical
#        `/api/v1`, `/api/v1/*`, or `/mcp` (or an interactive `CF_Authorization` session cookie with no
#        `Authorization` header on `/api/v1` / `/api/v1/*` excluding `/api/v1/health`).
#      - Request Header Transform (`http_request_late_transform`) strips client-supplied `cf-access-jwt-assertion`
#        and `cf-access-authenticated-user-email` headers on bypassed paths before origin delivery (A2).

# Credentials come from CLOUDFLARE_API_TOKEN in the deploy environment; never stored in variables or state (K1, K5).
provider "cloudflare" {}

locals {
  cloudflare_enabled      = var.cloudflare_zone_id != ""
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

  # Exact paths where `Authorization: Bearer fk_...` may bypass interactive Access (D9, D23, S5b).
  cloudflare_api_key_bypass_paths = [
    "/api/v1",
    "/api/v1/*",
    "/mcp",
  ]

  cloudflare_webhook_path_clauses = [
    for p in var.cloudflare_webhook_paths : (
      endswith(p, "/*")
      ? "starts_with(lower(http.request.uri.path), \"${lower(trimsuffix(p, "*"))}\")"
      : "lower(http.request.uri.path) eq \"${lower(p)}\""
    )
  ]
  cloudflare_webhook_path_expr = length(local.cloudflare_webhook_path_clauses) > 0 ? "(${join(" or ", local.cloudflare_webhook_path_clauses)})" : "false"

  # Broad case-insensitive scope guarded by pre-Access rulesets so case or subpath variations never slip through.
  cloudflare_fk_guard_scope_expr = "lower(http.host) eq \"${local.cloudflare_host}\" and (lower(http.request.uri.path) eq \"/api/v1\" or starts_with(lower(http.request.uri.path), \"/api/v1/\") or lower(http.request.uri.path) eq \"/mcp\" or starts_with(lower(http.request.uri.path), \"/mcp/\")) and not ${local.cloudflare_webhook_path_expr}"

  # Strict canonical path and `Bearer fk_<non-empty>` check (single Authorization header, non-empty secret suffix, no internal spaces).
  cloudflare_fk_canonical_path_expr = "(http.request.uri.path eq \"/api/v1\" or starts_with(http.request.uri.path, \"/api/v1/\") or http.request.uri.path eq \"/mcp\")"
  cloudflare_fk_bearer_expr         = "(len(http.request.headers[\"authorization\"]) eq 1 and starts_with(http.request.headers[\"authorization\"][0], \"Bearer fk_\") and len(trim(substring(http.request.headers[\"authorization\"][0], 7))) gt 3 and not (trim(substring(http.request.headers[\"authorization\"][0], 7)) contains \" \"))"
  cloudflare_fk_valid_request_expr  = "(${local.cloudflare_fk_canonical_path_expr} and ${local.cloudflare_fk_bearer_expr})"

  # Interactive Access browser session cookie on `/api/v1` and `/api/v1/*` (excluding `/api/v1/health`, R17/D22).
  cloudflare_access_cookie_expr = "(len(http.request.headers[\"authorization\"]) eq 0 and (http.request.uri.path eq \"/api/v1\" or starts_with(http.request.uri.path, \"/api/v1/\")) and http.request.uri.path ne \"/api/v1/health\" and any(http.request.headers[\"cookie\"][*] contains \"CF_Authorization=eyJ\"))"
}

# 1. Root Access Application: gates `/*` (including `/`, `/ui`, `/healthz`, `/metrics`, `/.well-known/*`).
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
        decision   = "service_auth"
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

# 3. Headless `fk_` API key bypass on `/api/v1`, `/api/v1/*`, and `/mcp` (D9, D23, S5b),
#    enforced at the edge by the pre-Access redirect and WAF custom rulesets below.
resource "cloudflare_zero_trust_access_application" "api_keys_bypass" {
  count            = local.cloudflare_enabled ? 1 : 0
  zone_id          = var.cloudflare_zone_id
  name             = "${local.name}-api-keys-bypass"
  type             = "self_hosted"
  domain           = "${local.cloudflare_host}/api/v1"
  session_duration = "24h"

  destinations = [
    for p in local.cloudflare_api_key_bypass_paths : {
      type = "public"
      uri  = "${local.cloudflare_host}${p}"
    }
  ]

  policies = [
    {
      name       = "bypass-fk-api-keys-guarded-by-waf"
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

# 4. Pre-Access redirect ruleset (`http_request_dynamic_redirect`): keyless requests on `/api/v1*` and `/mcp*`
#    (outside webhook paths) hit the Cloudflare Access login gate (S5b).
resource "cloudflare_ruleset" "api_keys_unauthenticated_redirect" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "${local.name}-api-keys-login-redirect"
  description = "Redirect keyless unauthenticated /api/v1 and /mcp requests to Cloudflare Access login (S5b)."
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      enabled     = true
      action      = "redirect"
      description = "Keyless requests on /api/v1 and /mcp redirect to the Access login gate"
      expression  = "(${local.cloudflare_fk_guard_scope_expr}) and len(http.request.headers[\"authorization\"]) eq 0 and not (${local.cloudflare_access_cookie_expr})"
      action_parameters = {
        from_value = {
          status_code           = 302
          preserve_query_string = false
          target_url = {
            value = "https://${local.cloudflare_host}/cdn-cgi/access/login"
          }
        }
      }
    },
  ]
}

# 5. Pre-Access WAF guard (`http_request_firewall_custom`): blocks any request on `/api/v1*` and `/mcp*`
#    (outside webhook paths) that does not carry a valid `Authorization: Bearer fk_<token>` (or an interactive
#    Access browser cookie with no Authorization header on `/api/v1*` excluding `/api/v1/health`).
resource "cloudflare_ruleset" "api_keys_bypass_guard" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "${local.name}-api-keys-bypass-guard"
  description = "Allow Access bypass on /api/v1 and /mcp only for Bearer fk_ API keys (D9, D23, S5b)."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      enabled     = true
      action      = "block"
      description = "Refuse non-fk_ credentials and unauthenticated requests on bypassed API and MCP paths"
      expression  = "(${local.cloudflare_fk_guard_scope_expr}) and not (${local.cloudflare_fk_valid_request_expr}) and not (${local.cloudflare_access_cookie_expr})"
    },
  ]
}

# 6. Post-Access header sanitization (`http_request_late_transform`): strip client-supplied Access headers on
#    bypassed paths so the origin never receives unstripped edge headers (A2).
resource "cloudflare_ruleset" "api_keys_header_sanitize" {
  count       = local.cloudflare_enabled ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "${local.name}-api-keys-header-sanitize"
  description = "Strip client-supplied Cloudflare Access headers on bypassed /api/v1 and /mcp paths (A2)."
  kind        = "zone"
  phase       = "http_request_late_transform"

  rules = [
    {
      enabled     = true
      action      = "rewrite"
      description = "Remove client-supplied cf-access headers on bypassed API and MCP paths"
      expression  = local.cloudflare_fk_guard_scope_expr
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
