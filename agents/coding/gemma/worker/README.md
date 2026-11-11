# Gemma Linear Agent Worker

**State:** Source configured for the Gemma Linear OAuth agent; not deployed/installed. This Worker is separate from the Gemini CLI and ChatGPT CLI identities.

## Application registration

Open [Linear's OAuth application creation page](https://linear.app/settings/api/applications/new) and import/prepopulate the sibling `../linear-oauth-app.manifest.json` file, or use the generated manifest URL documented in ABR-29. The manifest sets:

- Name: **Gemma**
- Distribution: **Private**
- Redirect: `https://linear-gemma.revrebel.io/oauth/callback`
- Webhook: `https://linear-gemma.revrebel.io/webhook`
- Webhook resource types: `AgentSessionEvent`, `OAuthAuthorization`, `PermissionChange`
- OAuth authorization: `actor=app`, scopes `read,write,app:assignable,app:mentionable` (requested during installation, *not* through the manifest)

An admin must submit the Linear application creation screen; the current Linear connector cannot create OAuth apps. Capture the generated client ID, client secret and signing secret in the approved secret store, never in Linear issues, Git or terminal history.

## Bridge configuration

Worker origin: `linear-gemma.revrebel.io`. **Different** from Tunnel receiver `gemma-agent.revrebel.io`, which must route to the existing authenticated bridge `/jobs`. Define or verify this Tunnel hostname before deployment. Do **not** point both hostnames at the same Worker. Protect `/webhook` using the existing source allowlist and Linear HMAC verification; explicitly permit OAuth installation and callback endpoints. Ensure the bridge has a dedicated `gemma` host/runner mapping before sending jobs (current production bridge does not yet dispatch Gemma).

The root `.env` (ignored) uses:
```bash
GEMMA_PREFIX=gemma
GEMMA_HOST="gemma-agent.revrebel.io"
GEMMA_KV_NAMESPACE_ID=
GEMMA_LINEAR_CLIENT_ID=
GEMMA_LINEAR_CLIENT_SECRET=
GEMMA_LINEAR_WEBHOOK_SECRET=
```

Keep `OPENROUTER_API_KEY` in the approved Ubuntu service-user secret store and expose it **only** to the dedicated Gemma runner, not the Worker and not other agents.

The repository scripts now recognize `gemma` with its nested `agents/coding/gemma/worker` path. Once the Linear app, DNS and Tunnel, service host mapping, SDK dependency, credentials and security gates are verified:

```bash
npm run setup:kv -- gemma
npm run types -- gemma
npm run typecheck
npm run deploy -- gemma
# After deployment, visit:
# https://linear-gemma.revrebel.io/install
```

**Do not deploy while the local bridge's `gemma` dispatch is unimplemented:** the existing bridge cannot safely execute its job, and an installed Linear app would receive assignments it cannot complete.

## Verification

1. Worker type generation, TypeScript checks and existing reliability tests.
2. OAuth install using `actor=app`, verify viewer/app identity and refresh storage in dedicated `LINEAR_DATA` KV.
3. Signed/unsigned webhook positive/negative tests, HMAC source allowlist, OAuth and renewal.
4. Host routing check: `gemma-agent.revrebel.io` matches **Gemma only**, and dispatch is implemented with read-only SDK inventory tools.
5. Assign one disposable issue as a *delegate* to Gemma and verify activity, replay idempotency, completion and session continuity.
6. Before any code-writing scope or ABR-28 assignment, explicitly approve tools, repository mapping, secrets handling, job recovery and sandbox enforcement.

[Linear agent documentation](https://linear.app/developers/agents) | [OAuth application manifests](https://linear.app/developers/oauth-app-manifests) | [ABR-29](https://linear.app/revrebel/issue/ABR-29)
