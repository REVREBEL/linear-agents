# Linear initiative/project routing

This folder contains the local router and [routing.example.json](routing.example.json), generated using live Linear project and initiative IDs on 2026-10-20.

## Install the local routing configuration

Copy the example into the **live bridge directory** as `routing.json` (do not replace the active `agent-bridge.mjs` on your Mac until a planned restart and test). The bridge reads this file at job-delivery time, so mapping edits do not require Worker redeployment:

```bash
cp routing.example.json routing.json
```

If your live bridge folder is `~/.linear-agent-bridge/`, use:

```bash
cp .linear-agent-bridge/routing.example.json ~/.linear-agent-bridge/routing.json
```

Edit `projectsRoot` to the **parent directory of local repository checkouts**. Example: `${HOME}/path/to/projects`.

The configuration is keyed by Linear's **UUIDs** rather than project titles. Each entry in `initiatives` maps the initiative to an approved repository, and each `projects` entry maps a project to one initiative, a **repository-relative** scope, and optional `launchFromScope`:

```json
{
  "version": 1,
  "projectsRoot": "${HOME}/path/to/projects",
  "initiatives": {
    "a7f15d16-f380-40d1-9bc8-c20021feb486": {
      "name": "Metrics",
      "repository": "REVREBEL/Metrics-Core"
    }
  },
  "projects": {
    "6bbdbe08-8af9-42cd-8055-bf31be23057e": {
      "name": "11 — Data Architecture Documentation",
      "initiativeId": "a7f15d16-f380-40d1-9bc8-c20021feb486",
      "scope": "apps/docs",
      "launchFromScope": false
    }
  }
}
```

`launchFromScope: false` intentionally starts the agent at the **repository root** for Git/workspace trust and consistent CLI project memory. The task prompt still identifies the relevant app subfolder. Set `true` **only** if an agent's trusted session is specifically established at that subfolder.

### Mappings requiring local verification

- Metrics: `Metrics-Core` is grounded in the sample Linear issue; Docs `apps/docs` is explicitly named there. Other Metrics projects are provisionally scoped to `.` until the correct monorepo subfolder is confirmed.
- Custom Booking Engine / Mew API: mapped to `REVREBEL/urban-cowboy-booking-engine`, default root scope.
- GuestBridge: the initiative and 11 project IDs are real, but the local GitHub repository name has **not** been verified. `REPLACE_WITH_VERIFIED_REPOSITORY` deliberately fails validation instead of dispatching to a guessed folder.

### Required Worker changes

All four Workers now query Linear for the assigned issue's project ID and initiative IDs using the app OAuth installation. The bridge requires `job.routing.projectId` and exactly one matching mapped `job.routing.initiativeIds`. If enrichment fails, **do not** fall back to parsing issue text. Verify the GraphQL query against the active Linear API schema and run an end-to-end smoke test before turning on this strict requirement in production.

### Storage and failures

Successful jobs are written into:

```text
<repository>/.linear-agent/projects/<linear-project-uuid>/inbox/<delivery-id>.json
```

The bridge attempts to add `/.linear-agent/` to the repository's **local** `.git/info/exclude`, so no tracked `.gitignore` changes are required. The task JSON includes resolved route metadata. Unknown projects, ambiguous initiatives, missing repositories, and invalid scopes are written to the bridge's centralized `linear-jobs/<agent>/*.unrouted.json`, returning HTTP 422 rather than launching in an unsafe fallback directory.

The central bridge still owns job dispatch and the existing `/complete` session contract. Moving the JSON file does not itself alter a CLI's trust model or ensure a resumed conversation. Test each runtime's session behavior explicitly.

### Deployment checklist

1. Put `routing.json` in the *actual* live bridge directory, beside `agent-bridge.mjs`.
2. Verify `projectsRoot`, exact checkout folder casing, the presence of each `.git`, and project scope directories.
3. Deploy **all four Workers**, because webhook routing enrichment is new.
4. Install the updated `agent-bridge.mjs` on your Mac and restart its LaunchAgent. Check that its `RUN_AGENT_PATH`, Python environment, Trae executable and Gemini executable still point to working locations.
5. Delegate a low-risk issue. Check Worker logs for successful project/initiative enrichment, and bridge logs for the resolved repository and created inbox file. Confirm the agent opened in the intended workspace and produced a terminal Linear Agent Activity.
6. Check error cases: unmapped project, missing initiative, missing repository, invalid scope, and duplicate event.

**Do not assume that changes committed to GitHub have automatically updated the live Mac process or the deployed Cloudflare Workers.**
