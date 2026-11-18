#!/usr/bin/env bash

bash scripts/with-env.sh terraform show -json \
  | jq -r '
    .values.root_module.resources[]
    | select(
        .address == "cloudflare_list.linear_webhooks"
        or .address == "cloudflare_ruleset.linear_webhook_waf[0]"
      )
    | "\(.address) = \(.values.id)"
  '