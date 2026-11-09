# Cross-platform bridge service scripts

The canonical code lives in `REVREBEL/linear-agents`. Production is deployed separately to `/home/agent-bridge`; the development checkout at `/home/rebel/linear-agents` must not be used as a service working directory.

- `npm run bridge:status`, `bridge:restart`, `bridge:load`, `bridge:unload`, and `bridge:doctor` dispatch by `uname -s` through `scripts/bridge.sh`.
- macOS runs the original `scripts/macos/bridge.sh` and its existing launchd installer.
- Linux operates the **existing** `agent-bridge.service` with `systemctl`; start/stop/restart use the account's narrow sudoers permission when not root. The script never edits the service unit.
- `npm run bridge:setup` invokes the platform installer. On Linux the default is **print-only**, even when the production checkout does not exist; an administrator running `npm run bridge:linux-setup -- --install` creates `agent-bridge.service` only if absent. `--replace` explicitly backs up and replaces it, but does not restart or enable.
- `npm run bridge:linux-setup` prints the Linux service template, and `npm run bridge:macos-setup` preserves the existing macOS installation workflow.
- The existing GitHub event publisher is platform-neutral (`scripts/publish-github-events.mjs`). macOS installs its existing launchd scheduler via `scripts/macos/install-github-event-publisher.sh`. Linux may install an **optional** systemd timer using `scripts/linux/install-github-event-publisher.sh --install` with administrator privileges. This timer is never enabled by the installer. Only enable it when the bridge account has authorized Git push credentials, and only on one active host.
- Linux supports an opt-in native headless ChatGPT execution adapter through the authenticated OpenCode CLI (`CHATGPT_HANDOFF_MODE=opencode`), retaining Ubuntu job state, scoped workspace routing, and Worker completion. No browser/Shortcuts automation is required. The GitHub review-user path can opt into `CHATGPT_REVIEW_MODE=inbox`, which writes an authenticated PR review task and can notify a configured Linear user. If it is disabled, Linux still returns retriable 503 without claiming an actionable review. The inbox does not itself wake ChatGPT web conversations. See `docs/UBUNTU_CHATGPT_OPENCODE.md`.
- ChatGPT Apple Shortcuts at `scripts/chatgpt-shortcuts/handoff.mjs` remain macOS-only. On Linux, the selected OpenCode CLI execution account must own its OpenAI/ChatGPT OAuth credentials and have permission to access mapped repositories.
- `.env` is sourced by `scripts/with-env.sh` for the bridge itself. Do not set macOS-only PATH values in production `.env`; systemd's explicit Volta PATH is used. Setting `projectsRoot` in `routing.json` is optional; removing it uses `PROJECTS_ROOT` from `.env`. Linux installation requires this variable explicitly set before installing; never infer coding repository roots from the production checkout. The publisher uses the bridge account's real home for Git credentials. Both unit templates quote paths with spaces.

## Migration checks

1. Review all scripts, then on Ubuntu run `npm run bridge:status`, `npm run bridge:doctor`, and `systemctl is-enabled agent-bridge.service`.
2. Compare `npm run bridge:linux-setup` output with your **existing** `/etc/systemd/system/agent-bridge.service` before considering a change. Its pre-existing user-specific customization is intentionally not overwritten.
3. Test signed Worker → tunnel → bridge with existing health/probe diagnostics before Mac tunnel cutover.
4. Preserve persistent `linear-jobs`, routed inboxes, `.env`, and `routing.json` when deploying approved Git commits. The installer does not copy or mutate runtime job state.
5. Agent processes inherit the service identity unless explicitly delegated. Running as `bridge` does not mean they run as `rebel`.
