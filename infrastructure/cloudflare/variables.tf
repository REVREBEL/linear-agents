variable "cloudflare_account_id" {
  description = "Cloudflare account ID. Set through TF_VAR_cloudflare_account_id by scripts/with-env.sh."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "revrebel.io zone ID, used for WAF import and configuration."
  type        = string
}
