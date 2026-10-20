# Existing revrebel.io WAF custom ruleset.
#
# DO NOT declare a partial cloudflare_ruleset resource before importing the
# complete existing ruleset. Terraform manages the rules array as a whole.
# During the next step, inspect Cloudflare's live http_request_firewall_custom
# phase, generate its configuration, and import:
#
# terraform import cloudflare_ruleset.linear_webhook_waf \
#   "zones/<ZONE_ID>/<RULESET_ID>"
#
# Preserve every pre-existing rule and its ref/order when adding the Linear
# /webhook rule. The intended expression is documented in:
# docs/LINEAR_WEBHOOK_TRAFFIC_PROTECTION.md
