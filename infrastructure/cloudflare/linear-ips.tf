# Snapshot of Linear's official webhook source IPs.
# Verify https://linear.app/.well-known/appspecific/app.linear.ips.json
# before applying changes. Do not include codingSessionIps.
locals {
  linear_webhook_ips = [
    "34.134.222.122",
    "34.140.253.14",
    "34.185.239.137",
    "34.186.126.124",
    "34.38.87.206",
    "34.48.40.158",
    "34.60.255.158",
    "34.62.119.29",
    "35.196.141.51",
    "35.222.25.142",
    "35.231.147.226",
    "35.236.218.67",
    "35.243.134.228",
    "35.246.206.27",
    "35.246.210.220"
  ]
}

resource "cloudflare_list" "linear_webhooks" {
  account_id  = var.cloudflare_account_id
  name        = "linear_webhooks"
  kind        = "ip"
  description = "Official Linear webhook source IPs (maintained in Terraform)"

  items = [for ip in local.linear_webhook_ips : { ip = ip }]
}
