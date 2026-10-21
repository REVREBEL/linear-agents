# Supervised ChatGPT Project handoff test

This is an **optional, manual local experiment**. It does not modify the Linear webhook bridge, launchd service, Worker configuration, or routing.json and does not create a ChatGPT Work task. Browser automation of chatgpt.com is unofficial; review applicable service terms before using it.

## Setup

```bash
cd ~/.linear-agents
git pull origin main
npm install --prefix scripts/chatgpt-playwright
```

Requires Node 20+ and an installed Google Chrome. The Playwright test uses a dedicated Chrome profile at `~/.linear-agents-chatgpt-playwright`. Log into ChatGPT in the window opened by the script. Do not share or commit that browser profile.

## First test

```bash
npm run chatgpt:playwright -- \
  --project-url "https://chatgpt.com/g/g-p-REPLACE_WITH_REAL_PROJECT_URL/project" \
  --prompt "Reply with exactly: PLAYWRIGHT HANDOFF SUCCESS" \
  --keep-open
```

The script checks the hostname, opens the specified Project, and waits. **You must select New chat within the intended project yourself**; it does not try to guess UI selectors or choose the project automatically after navigation. After you press Return, it fills the visible composer and waits for an explicit `SEND` confirmation before pressing Enter. Inspect the correct project and new chat in the browser before sending.

`--keep-open` leaves Google Chrome running after submission until you press Ctrl+C in that Terminal. The default remains an interactive Return-to-close test. This is not yet a reusable daemon or external-command listener, so a second CLI invocation cannot attach to the running test. The stored profile and server-side ChatGPT conversations remain available after Chrome closes.

This does not read or scrape response contents, provide guaranteed conversation identity, or support unattended assignments. If the composer selector changes, the script stops. No secrets are needed beyond a manual login in the dedicated browser. A successful test only proves supervised browser input; it does not prove usage accounting, ChatGPT Work invocation, or future automatic Linear issue handling.

## Clean up

Quit the test browser normally. Delete `~/.linear-agents-chatgpt-playwright` manually if you want to remove the dedicated login/profile. The profile is not inside the Git repository.

## Linear bridge mapping (supervised only)

In your **local** ignored `linear-agent-bridge/routing.json`, configure `projects[LINEAR_PROJECT_UUID].chatgpt.projectUrl` with a ChatGPT Project base URL. The bridge checks that the URL is a `https://chatgpt.com/g/g-p-...` project URL. Do not include a `/c/...` existing conversation suffix if you want a new chat.

Set `CHATGPT_HANDOFF_MODE=supervised-playwright` in the root `.env` and restart the bridge **only when no jobs are active**. This mode does **not** automatically send messages or open Chrome from launchd. On a valid Linear ChatGPT job, the bridge writes a private `*.chatgpt-handoff.json` alongside the existing job JSON and records `awaiting_external` in the ledger. Find the path in the bridge logs. Then run:

```bash
npm run chatgpt:playwright -- --handoff-file "/absolute/path/to/job.json.chatgpt-handoff.json" --keep-open
```

The supervised controller opens the mapped Project, waits for you to select a new conversation, fills the prompt, and requests `SEND`. Existing conversation targeting, unattended/browser background job dispatch, response capture, and completion callbacks are **not** implemented. The successful Playwright test does not establish these capabilities. The bridge's existing initiative/repository routing requirements still apply; standalone projects without a mapped initiative may be rejected before ChatGPT handoff.
