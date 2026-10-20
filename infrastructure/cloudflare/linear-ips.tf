resource "cloudflare_list" "linear_webhooks" {
  account_id = var.cloudflare_account_id
  name       = "linear_webhooks"
  kind       = "ip"
}
