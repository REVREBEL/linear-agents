# ChatGPT Playwright handoff

**Implementation reference, 2026-10-28.** The checked-in bridge supports automated prompt submission to an **existing** ChatGPT conversation when explicitly enabled. Browser control uses Playwright; it is not a ChatGPT API integration and does not verify that an LLM completed a task.

## Setup

From the repository checkout, run `npm install --prefix scripts/chatgpt-playwright`. A local Google Chrome installation and an authenticated **dedicated** Chrome profile are needed for visible-browser use. Do not commit profiles or session cookies.

## Route configuration

In the ignored `linear-agent-bridge/routing.json`, configure the mapped Linear project's `chatgpt` object. For unattended submission use:

```json
{
  "chatgpt": {
    "projectUrl": "https://chatgpt.com/g/g-p-REAL_PROJECT_ID/c/REAL_CONVERSATION_ID",
    "conversationMode": "reuse-existing",
    "autoSend": true
  }
}
```

`reuse-existing` requires a validated ChatGPT Project conversation URL (`/g/g-p-.../c/...`). The default `new-per-issue` mode requires a **Project base URL** and remains supervised: the operator must create the new chat. The bridge rejects `autoSend: true` unless the mode is `reuse-existing`. Do not use arbitrary web URLs or a different conversation than the mapped target.

## Execution

The bridge creates a private `*.chatgpt-handoff.json` alongside the job. Automatic handoffs are serialized within the running bridge process because all handoffs connect to the same Chrome CDP browser, even across different conversation URLs. A failed controller exit marks the local job `failed`, while a successful exit only confirms a submission attempt. This queue is in-process and is not crash-durable; do not assume that restarting the bridge or launching the CLI independently prevents overlapping submissions. When `autoSend: true`, it starts the handoff script with noninteractive submission; otherwise `CHATGPT_HANDOFF_MODE=supervised-playwright` enables manual handoff. The CLI can also run directly:

```bash
npm run chatgpt:playwright -- --handoff-file "/absolute/path/to/job.json.chatgpt-handoff.json" --keep-open
npm run chatgpt:playwright -- --project-url "https://chatgpt.com/g/g-p-REAL_ID/project" --prompt "Test" --keep-open
npm run chatgpt:playwright -- --project-url "https://chatgpt.com/g/g-p-REAL_ID/project" --prompt "Test" --headless --dry-run
```

`--keep-open` runs the **visible Chrome process independently** from the Playwright controller through local CDP (`127.0.0.1:19228` by default). The dedicated profile allows the controller to reconnect, and automation failure does not intentionally terminate that Chrome process. **Security:** the unauthenticated Chrome DevTools Protocol endpoint grants control of the signed-in browser. Loopback binding alone does not prevent other local users or untrusted local processes from connecting. Use this mode only on a trusted single-user Mac with appropriately restricted local access, or implement and verify OS-level endpoint isolation before running on a shared host. Do not forward CDP ports through a tunnel or expose them to a network. The controller polls for a visible composer for up to **45 seconds**, fills it, confirms nonempty normalized editor content, and attempts Enter submission. It logs useful destination/selector errors. Check the destination and message yourself; Enter attempted is not proof the service accepted or completed the message.

`--headless` uses **native Playwright Chromium** with an isolated browser context, rather than connecting to the visible Chrome/CDP process. The script reserves a separate headless debugging-port configuration but its native headless launch does not attach to a persistent Chrome process. Headless mode starts without an authenticated visible Chrome profile, so it may require additional setup to reach an authenticated composer. It is primarily a test mode.

## Limitations and safety

The current implementation does not capture model responses, infer task completion, establish ChatGPT Work task identity, or turn a browser submit into a verified Linear completion callback. Preserve browser credentials locally. A configured `autoSend` is deliberate authorization to submit automatically to the mapped conversation. Avoid rerunning a job if duplicate content would be harmful. See `linear-agent-bridge/agent-bridge.mjs` and `scripts/chatgpt-playwright/handoff-test.mjs` for the authoritative implementation.
