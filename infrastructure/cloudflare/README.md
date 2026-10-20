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

**Stop here before importing.** `linear-ips.tf` currently declares the existing account-level IP list but has no item contents. The `waf-rules.tf` file deliberately contains only notes, not a partial WAF ruleset that could overwrite your other rules. After we can inspect the live Cloudflare resources, we will reconcile the full list/ruleset declarations and import both into Terraform state. **Do not run `terraform apply` yet.**

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

## Next step: importing existing resources

Once values are filled in, we will first read the live list and WAF ruleset and create matching Terraform configuration. Then:

1. `terraform import cloudflare_list.linear_webhooks "ACCOUNT_ID/LIST_ID"`.
2. Declare the **complete existing** WAF custom ruleset, including unrelated rules and their order, before importing it.
3. Import the ruleset with the exact ID and resource address.
4. Run `terraform plan` and confirm **no unexpected changes**.
5. Only then consider any `apply`.

See [Linear webhook traffic protection](../../docs/LINEAR_WEBHOOK_TRAFFIC_PROTECTION.md) for the intended IP list, WAF expression, and the existing Cloudflare access limitations.
