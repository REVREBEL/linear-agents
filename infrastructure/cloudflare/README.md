# Central environment and Cloudflare Terraform

This project uses **one local secret source**: `/.env`, copied from the committed `/.env.example`. The old per-Worker `.dev.vars.example` files are intentionally removed.

## Local setup

From the repository root:

```bash
cp .env.example .env
# Edit .env in your editor. It is ignored by Git.
```

This file is a **trusted shell-compatible** environment file, loaded with Bash `source` by `scripts/with-env.sh`. For values containing punctuation, whitespace, or `#`, quote them as shell strings. Do not insert untrusted code in `.env`. Values must not be committed or pasted into issues.

The central template groups:
- Cloudflare token, account/zone IDs, and existing list/ruleset IDs for the later import.
- Four separately named sets of Linear OAuth app credentials and webhook HMAC secrets. Each Worker still receives the familiar `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and `LINEAR_WEBHOOK_SECRET` names.
- A single `BRIDGE_SHARED_SECRET` used by the bridge and all four Workers.
- Optional local bridge paths and executables.

## Terraform commands

The wrapper loads `/.env`, exports `TF_VAR_cloudflare_account_id` and `TF_VAR_cloudflare_zone_id`, and runs Terraform from `infrastructure/cloudflare`. No `.tfvars` file is needed.

```bash
bash scripts/with-env.sh terraform init
bash scripts/with-env.sh terraform fmt
bash scripts/with-env.sh terraform validate
```

The list and its 15 webhook IPs are now fully declared by Terraform. The IP snapshot comes from Linear's official `ips` feed; do not add `codingSessionIps` (those serve a different purpose). Check https://linear.app/.well-known/appspecific/app.linear.ips.json before updating/applying.

The WAF ruleset is also declared, but **opted out by default** (`manage_linear_webhook_waf = false`). A zone's custom WAF ruleset is an authoritative ordered array. Creating one without discovering the existing ruleset or importing *all* existing rules can conflict with or replace unrelated security policy. **Never enable the toggle until you have confirmed there is no existing zone entrypoint custom ruleset**, or have imported it and added its existing rules to the resource configuration.

## First-time provisioning (no existing list or WAF custom ruleset)

1. Verify in Cloudflare that the account has **no list named `linear_webhooks`** and the zone has **no existing `http_request_firewall_custom` entrypoint ruleset**. Otherwise, stop and reconcile/import existing resources instead of creating duplicates.
2. Confirm `DOMAIN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_ID`, and `CLOUDFLARE_API_TOKEN` in root `.env`. Token needs Account Filter Lists Edit/Read and Zone WAF Write.
3. Start with the list only:

```bash
bash scripts/with-env.sh terraform init
bash scripts/with-env.sh terraform fmt -check
bash scripts/with-env.sh terraform validate
bash scripts/with-env.sh terraform plan
# Review that only the IP list is created, then:
bash scripts/with-env.sh terraform apply
```

4. Only after confirming no existing custom ruleset, opt into the WAF:

```bash
TF_VAR_manage_linear_webhook_waf=true bash scripts/with-env.sh terraform plan
# Review the exact ruleset and changes; only then:
TF_VAR_manage_linear_webhook_waf=true bash scripts/with-env.sh terraform apply
```

**Important:** The `TF_VAR_manage_linear_webhook_waf=true` override must also be provided on subsequent Terraform runs. Omitting it after applying would plan **destruction** of the managed WAF ruleset. Persist it in your trusted local `.env` as `TF_VAR_manage_linear_webhook_waf=true` once provisioning is approved.

Never apply a plan that removes other rules or changes their order. Review the Cloudflare dashboard after applying, and confirm a permitted Linear webhook succeeds. The WAF rule applies only to `POST /webhook` on the four configured Worker hostnames; it blocks all other methods or unlisted source IPs there. It does **not** block unrelated probing of other paths such as `/oauth/callback/v1/models`.

If existing resources are discovered, use Terraform import with the correct resource addresses and reconcile all list items and rules before applying. A pre-existing custom ruleset is **not** safely imported by merely adding its ID; first model its full rules array and ordering. Do not use `apply` for the WAF until `plan` shows no unexpected deletions.

Terraform's provider reads `CLOUDFLARE_API_TOKEN` from the environment. Account and zone resource IDs are not confidential, but keep your access token in `.env`.

## Worker commands

Run from the repository root:

```bash
# Run one Worker locally with temporary secrets from root .env.
bash scripts/with-env.sh worker antigravity dev
bash scripts/with-env.sh worker trae dev

# Deploy code and configuration (does not automatically upload secrets).
bash scripts/with-env.sh worker chatgpt deploy

# Explicitly upload the four secrets for one existing Worker.
bash scripts/with-env.sh worker chatgpt sync-secrets
```

The four agent labels accepted are `antigravity`, `trae`, `chatgpt`, `gemini`.

**Local development:** the wrapper creates a temporary, mode-restricted `.dev.vars` in the selected Worker directory, runs `wrangler dev`, and removes the temporary file when it exits. It refuses to overwrite an existing `.dev.vars`. Do not run concurrent `dev` sessions for the same Worker.

**Production:** `wrangler deploy` does **not** promote root `.env` values to deployed secrets. `sync-secrets` explicitly streams those values to `wrangler secret put` for the selected Worker using the account authenticated by Wrangler. Review the Worker destination and secret values before running this command against production.

**Static Worker values:** hostnames, OAuth redirect URLs, KV IDs, and Worker names remain in each `wrangler.jsonc` because they are deployment configuration, not duplicated secret inputs. No per-Worker `.tfvars` is needed.

## Local bridge

For manual starts from this repository, the helper supports:

```bash
bash scripts/with-env.sh bridge
```

This does **not** alter a macOS LaunchAgent already starting the live bridge from another directory. A LaunchAgent will only inherit this central `.env` if you change its startup command to load it or configure those environment variables explicitly. Do not change or restart your running bridge during the Terraform import preparation.

