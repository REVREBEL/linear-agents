---
name: github-app-bot-workflow
description: Complete guide for Antigravity agents to commit, push branches, and create pull requests using the GitHub App bot identity (rebel-antigravity[bot]) for both Linear-routed and standalone non-Linear tasks on macOS and Linux (Ubuntu).
---

# GitHub App Bot Workflow (`rebel-antigravity[bot]`)

Use this skill whenever you need to commit changes, push Git branches, or open Pull Requests across REVREBEL repositories.

> [!IMPORTANT]
> **Never ask the user for a Personal Access Token (PAT).**
> All Git commits, pushes, and Pull Requests MUST be authenticated and attributed to the GitHub App bot (`rebel-antigravity[bot]`, App ID `5411353`).

---

## 1. Identity & Credentials Reference

| Property | Value | Notes |
| :--- | :--- | :--- |
| **App Name** | `rebel-antigravity` | GitHub App Slug |
| **App ID** | `5411353` | Numeric ID |
| **Bot Git Name** | `rebel-antigravity[bot]` | `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` |
| **Bot Git Email** | `5411353+rebel-antigravity[bot]@users.noreply.github.com` | `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` |
| **Private Key** | `~/.gemini/credentials/github-rebel-antigravity.private-key.pem` | RSA 2048 private key |
| **Token Generator** | `~/.gemini/scripts/mint-github-app-token.mjs` | Mints ephemeral installation token |
| **Git Bot Env Script** | `~/.gemini/scripts/git-bot-env.sh` | Exports Git author/committer env vars |
| **GitHub App MCP Server** | `~/.gemini/scripts/github-app-mcp.mjs` | Spawns `@modelcontextprotocol/server-github` |

---

## 2. Linux (Ubuntu) vs. macOS Differences

| Aspect | macOS (Local Dev) | Linux (Ubuntu Server) |
| :--- | :--- | :--- |
| **Home Directory (`$HOME`)** | `/Users/<username>` | `/home/<username>` (e.g. `/home/rebel`) |
| **Path Expansion** | Always use `~` or `$HOME` (e.g. `$HOME/.gemini/...`) | Always use `~` or `$HOME` (e.g. `$HOME/.gemini/...`) |
| **Node.js Path** | System / NVM default in PATH (`node`) | `~/.nvm/current/bin/node` or system `node` |
| **Subprocess Execution** | Zsh / Bash | Bash |

> [!TIP]
> Never hardcode `/Users/...` or `/home/...` in scripts or Git commands. Always use `$HOME` or `~` so the commands run portably on both macOS and Linux.

---

## 3. Workflow Procedures

### Procedure A: Linear-Routed Task (via `run_agent.py`)

When a task arrives through the Linear bridge:
1. **Environment is Pre-configured**:
   - `run_agent.py` automatically injects `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` into the agent's subprocess.
2. **Make Git Commits**:
   ```bash
   git add <modified-files>
   git commit -m "feat(scope): descriptive commit message"
   ```
3. **Push Branch using Ephemeral App Token**:
   ```bash
   APP_TOKEN=$(node "$HOME/.gemini/scripts/mint-github-app-token.mjs")
   git push "https://x-access-token:${APP_TOKEN}@github.com/REVREBEL/<repo>.git" <branch-name>
   ```
4. **Create Pull Request**:
   - **Preferred**: Call the GitHub MCP tool `create_pull_request`.
   - **Alternative (CLI/API)**:
     ```bash
     APP_TOKEN=$(node "$HOME/.gemini/scripts/mint-github-app-token.mjs")
     curl -s -X POST "https://api.github.com/repos/REVREBEL/<repo>/pulls" \
       -H "Authorization: Bearer ${APP_TOKEN}" \
       -H "Accept: application/vnd.github+json" \
       -H "User-Agent: rebel-antigravity" \
       -d '{"title":"...","head":"<branch>","base":"main","body":"..."}'
     ```
5. **Linear Completion**:
   - Post PR link to Linear issue and complete session via `linear-session-completion`.

---

### Procedure B: Standalone / Non-Linear Task (Started in AGY Directly)

When a task is started directly in Antigravity (IDE, CLI, or Desktop) without Linear:

1. **Step 1: Export Bot Git Identity**:
   Run or source the bot env script before committing:
   ```bash
   source "$HOME/.gemini/scripts/git-bot-env.sh"
   ```
   *(Or manually export the `GIT_AUTHOR_*` and `GIT_COMMITTER_*` variables shown in Section 1).*

2. **Step 2: Commit Changes**:
   ```bash
   git add <files>
   git commit -m "feat: your change description"
   ```
   Verify author attribution with:
   ```bash
   git log -1 --format=fuller
   ```

3. **Step 3: Push Branch via App Token**:
   ```bash
   APP_TOKEN=$(node "$HOME/.gemini/scripts/mint-github-app-token.mjs")
   git push "https://x-access-token:${APP_TOKEN}@github.com/REVREBEL/<repo>.git" <branch-name>
   ```

4. **Step 4: Create Pull Request**:
   - Use the built-in GitHub MCP tool `create_pull_request`.
   - If MCP is not available in that specific terminal subshell, use the GitHub REST API with `APP_TOKEN`.

---

## 4. Troubleshooting & Best Practices

1. **`ENOENT: no such file or directory, open '.gemini/credentials/...'`**:
   - Occurs when relative paths are passed to Node `fs.readFile()`.
   - Always resolve against `$HOME` or `os.homedir()`.
2. **`Permission denied (publickey)` or 403 on push**:
   - Do NOT try `git push origin <branch>` via SSH unless SSH keys are explicitly configured on the machine.
   - Always push over HTTPS using `https://x-access-token:${APP_TOKEN}@github.com/REVREBEL/<repo>.git`.
3. **Never Commit Secrets**:
   - Do NOT commit `.pem` private keys, minted `ghs_...` tokens, or `.env` files to Git.
