# Linear Webhook Traffic Protection

## Scope and verification status (2026-10-20)

This document records the separate Cloudflare WAF hardening work order for the Linear agent Workers. **GitHub configuration and public vendor documentation have been checked; live Cloudflare account WAF rules, list contents and deployed Worker settings could not be inspected because the connected Cloudflare API returned internal errors.** Do not interpret this document as proof that the rule is deployed.

### Covered Workers

| Worker hostname | Route | Result |
| --- | --- | --- |
| `linear-antigravity.revrebel.io` | `POST /webhook` | Intended protected endpoint |
| `linear-trae.revrebel.io` | `POST /webhook` | Intended protected endpoint |
| `linear-chatgpt.revrebel.io` | `POST /webhook` | Intended protected endpoint |
| `linear-gemini.revrebel.io` | `POST /webhook` | Intended protected endpoint |

The rule matches future `*.revrebel.io` hostnames containing `linear` as well, not just the four above. Review whether that broad match is acceptable before adding other public Linear-named services.

### WAF expression

Intended zone-level Cloudflare WAF custom rule, action **Block**:

```text
ends_with(http.host, ".revrebel.io")
and http.host contains "linear"
and http.request.uri.path eq "/webhook"
and (
  http.request.method ne "POST"
  or not ip.src in $linear_webhooks
)
```

This uses the correct Cloudflare custom-list syntax `ip.src in $linear_webhooks`. The WAF blocks non-POST requests and source IPs outside the list on **only** `/webhook`. This rule intentionally does **not** restrict `/install`, `/oauth/callback`, `/health`, `/complete` or the home route. Completion authorization must be enforced by the Worker independently; leaving the route public does not imply unauthenticated access.

### Cloudflare IP list

- Type: **IP addresses**
- List name: **`linear_webhooks`**
- Source of truth: https://linear.app/.well-known/appspecific/app.linear.ips.json
- Documentation: https://linear.app/docs/security
- Last manually checked: **2026-10-20**

Current published addresses from Linear's Security page:

```text
34.134.222.122
34.140.253.14
34.185.239.137
34.186.126.124
34.38.87.206
34.48.40.158
34.60.255.158
34.62.119.29
35.196.141.51
35.222.25.142
35.231.147.226
35.236.218.67
35.243.134.228
35.246.206.27
35.246.210.220
```

The work order contained **9** IPs; Linear currently publishes **15**. Additional published addresses missing from that original list:

```text
34.185.239.137
34.186.126.124
34.48.40.158
35.236.218.67
35.246.206.27
35.246.210.220
```

**Maintenance requirement:** Compare the Cloudflare IP list with Linear's published JSON periodically, and update the list *before* Linear begins using newly advertised IPs. Avoid automatically overwriting the list without review.

### Worker configuration verified in GitHub

Each of the four `linear-*-worker/wrangler.jsonc` files explicitly configures:

```json
"workers_dev": false,
"preview_urls": false
```

These are source-level confirmations. Reconfirm against deployed Worker settings in Cloudflare.

### Worker-side verification

Current code: signature verification of raw body via `Linear-Signature` HMAC-SHA256 is present in the four Worker `src/index.ts` files. **Timestamp freshness validation is missing**. Linear recommends checking `webhookTimestamp` against the current time with approximately a 60-second tolerance. The `Linear-Timestamp` header also exists, but timestamp checks must be designed to match Linear's signed payload and replay defense. A WAF allowlist is defense in depth, not a substitute for signature and freshness validation.

**Action required:** Add and test Worker timestamp freshness validation across all four agents before reporting the work order as fully complete. The current repository has *not* been changed to enforce freshness as part of this documentation review.

### Cloudflare dashboard verification checklist

1. Under the Cloudflare account's **Lists**, confirm an IP list named exactly `linear_webhooks` exists and contains all 15 currently published addresses.
2. For the `revrebel.io` zone, inspect **Security → WAF → Custom rules** (UI names may vary). Confirm an **enabled** rule with the expression above and **Block** action.
3. Confirm no preceding Skip/Allow rule bypasses the intended protection and no separate custom hostname accidentally matches.
4. Inspect all four production Worker settings and routes. Confirm `workers.dev` and preview URL exposure are disabled in deployment, not just Wrangler files.
5. Verify that a request to `/webhook` from an unlisted IP is blocked at WAF. Do not expose production webhook secrets for testing.
6. Confirm normal browser OAuth `/install` and `/oauth/callback` requests can reach Workers.
7. Trigger an authorized test Linear webhook. Confirm it reaches Worker HMAC verification and generates the expected Agent Activity, rather than producing a WAF-blocked event.
8. Check WAF security events for false positives and review the list on Linear's published update cycle.

### Source links

- Linear: https://linear.app/docs/security
- Linear webhooks: https://linear.app/developers/webhooks
- Linear IP JSON: https://linear.app/.well-known/appspecific/app.linear.ips.json
- Cloudflare custom lists: https://developers.cloudflare.com/waf/tools/lists/custom-lists/
- Cloudflare use lists in expressions: https://developers.cloudflare.com/waf/tools/lists/use-in-expressions/

### Outstanding verification

- Live Cloudflare list ID, actual list entries, zone WAF ruleset/rule ID, enabled state and rule ordering: **not verified**.
- Deployed Worker `workers.dev` and preview settings: **not verified**.
- Worker timestamp validation: **confirmed absent in checked-in source**.
