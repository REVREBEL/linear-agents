variable "cloudflare_account_id" {
  description = "Cloudflare account ID. Set through TF_VAR_cloudflare_account_id by scripts/with-env.sh."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID used for WAF configuration."
  type        = string
}

variable "cloudflare_domain" {
  description = "Zone domain containing the four Linear Worker custom hostnames."
  type        = string
}

variable "manage_linear_webhook_waf" {
  description = "Opt in only after verifying the zone has no existing custom ruleset, or modeling and importing all existing custom rules."
  type        = bool
  default     = false
}
