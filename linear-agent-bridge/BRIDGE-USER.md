# Ubuntu agent execution account

The production `agent-bridge.service` runs as the **bridge** Unix account (`User=bridge`, `Group=bridge`). Its child Antigravity, Gemini, Trae, and OpenCode processes inherit that account. Linux startup now refuses any other account. The ChatGPT/OpenCode adapter no longer sudo-switches to `CHATGPT_OPENCODE_USER` on Linux.

## Provision agent CLIs as bridge

Use the existing home directory associated with the `bridge` account (normally `/home/agent-bridge`). Do **not** install credentials or agent state under root, rebel, or opencode, and do not recursively chown unrelated repositories or services.

From an administrator shell:

```bash
getent passwd bridge
systemctl show agent-bridge.service -p User -p Group -p WorkingDirectory
sudo -u bridge -H sh -c 'printf "USER=%s HOME=%s\n" "$(id -un)" "$HOME"; command -v agy || true; command -v gemini || true; command -v trae || true; command -v opencode || true'
```

For interactive installation/authentication, use `sudo -iu bridge` (or `sudo -u bridge -H bash` if the service account has no login shell). Install each vendor CLI using its supported user-local installer or package workflow **in that session**; authenticate each separately. Keep OpenCode's authenticated config and sessions within the bridge home. Do not copy credentials blindly from another account.

In `/home/agent-bridge/.env` (or the configured environment file), use the correct bridge-owned paths, for example:

```dotenv
ANTIGRAVITY_BIN=/home/agent-bridge/.local/bin/agy
OPENCODE_BIN=/home/agent-bridge/.opencode/bin/opencode
CHATGPT_OPENCODE_USER=
```

Set `GEMINI_BIN` and `TRAE_BIN` to their verified executables in the bridge environment. Do not assume installations exist at those paths.

## Deploy updated bridge service

```bash
git pull --ff-only
npm run bridge:restart
systemctl show agent-bridge.service -p User -p Group -p MainPID
sudo -u bridge -H sh -c 'test -x /home/agent-bridge/.opencode/bin/opencode && /home/agent-bridge/.opencode/bin/opencode --version'
journalctl -u agent-bridge.service -n 50 --no-pager
```

**Systemd unit PATH:** The Linux installer now includes `$HOME/.opencode/bin`, along with Volta, Bun, and `.local/bin`. Existing installed units need `scripts/linux/install-systemd.sh --replace` followed by `systemctl daemon-reload` and a planned restart if you want that PATH change; updating `OPENCODE_BIN` to an absolute path does not require changing the unit.

**Verification:** `ps -eo user,pid,ppid,args` should show the bridge and any spawned coding CLI under `bridge`. A running bridge with no queued agents does not prove the CLIs are installed or authenticated. The bridge continues to use the existing routing.json project-to-repository assignments; this account change does not repair Linear GraphQL permissions.
