# IMPORTANT: The zone entrypoint ruleset is authoritative for *all* WAF custom
# rules in this zone. Enable ONLY after verifying no ruleset exists, or after
# importing and modeling every existing rule (with its order) in this file.
# Terraform does not merge rules with Cloudflare's existing zone ruleset.
resource "cloudflare_ruleset" "linear_webhook_waf" {
  count       = var.manage_linear_webhook_waf ? 1 : 0
  zone_id     = var.cloudflare_zone_id
  name        = "Zone custom firewall rules"
  description = "WAF custom rules managed by Terraform"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "block_untrusted_linear_webhooks"
      description = "Block non-POST or untrusted source IPs on Linear webhook endpoints"
      action      = "block"
      enabled     = true
      expression  = "(http.host in {\\"linear-antigravity.${var.cloudflare_domain}\\" \\"linear-trae.${var.cloudflare_domain}\\" \\"linear-gemini.${var.cloudflare_domain}\\" \\"linear-chatgpt.${var.cloudflare_domain}\\"} and http.request.uri.path eq \\"/webhook\\" and (http.request.method ne \\"POST\\" or not ip.src in $linear_webhooks))"
    }
  ]

  depends_on = [cloudflare_list.linear_webhooks]
}
