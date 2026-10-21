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
  --prompt "Reply with exactly: PLAYWRIGHT HANDOFF SUCCESS"
```

The script checks the hostname, opens the specified Project, and waits. **You must select New chat within the intended project yourself**; it does not try to guess UI selectors or choose the project automatically after navigation. After you press Return, it fills the visible composer and waits for an explicit `SEND` confirmation before pressing Enter. Inspect the correct project and new chat in the browser before sending.

This does not read or scrape response contents, provide guaranteed conversation identity, or support unattended assignments. If the composer selector changes, the script stops. No secrets are needed beyond a manual login in the dedicated browser. A successful test only proves supervised browser input; it does not prove usage accounting, ChatGPT Work invocation, or future automatic Linear issue handling.

## Clean up

Quit the test browser normally. Delete `~/.linear-agents-chatgpt-playwright` manually if you want to remove the dedicated login/profile. The profile is not inside the Git repository.
