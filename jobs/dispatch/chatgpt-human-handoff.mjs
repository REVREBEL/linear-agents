import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Human ChatGPT browser/Shortcuts handoff, separate from the CLI coding
 * agent and authenticated review inbox. The bridge owns job state and queue.
 */
export async function dispatchChatgptHumanHandoff({
  route, job: routedJob, filename, safeJobId, jobKey,
  jobStore, extractPromptContext, enqueueChatgptHandoff,
  projectDir: PROJECT_DIR,
  platform = process.platform, env = process.env,
  spawnProcess = spawn, execPath = process.execPath,
  logger = console,
}) {
      if (!route.chatgptProjectUrl) {
        await jobStore.transition(jobKey, "failed", { error: "No chatgpt.projectUrl in Linear project mapping" });
        logger.error("ChatGPT handoff stopped: project mapping has no chatgpt.projectUrl");
      } else if (platform !== "darwin") {
        // Keep the task but never claim a UI/browser handoff was launched.
        await jobStore.transition(jobKey, "awaiting_external", {
          taskFile: filename,
          note: "Linux ChatGPT browser/Shortcuts handoff unsupported; task retained for a supported runner; automatic dispatch not attempted"
        });
        logger.warn(`ChatGPT Linux handoff deferred (no browser launched): ${filename}`);
      } else if (["supervised-playwright", "shortcuts"].includes(env.CHATGPT_HANDOFF_MODE) || route.chatgptAutoSend === true) {
        const promptContext = extractPromptContext(routedJob);
        if (!promptContext) {
          await jobStore.transition(jobKey, "failed", { error: "Missing ChatGPT promptContext" });
        } else {
          const useShortcuts = env.CHATGPT_HANDOFF_MODE === "shortcuts";
          const script = path.resolve(PROJECT_DIR, useShortcuts
            ? "../scripts/chatgpt-shortcuts/handoff.mjs"
            : "../scripts/chatgpt-playwright/handoff-test.mjs");
          // This supervised test requires an attached terminal, and must not consume the daemon stdin.
          // Queue a ready-to-run handoff command as a local file instead of launching UI automation from launchd.
          const handoffFile = filename + ".chatgpt-handoff.json";
          const handoffId = safeJobId;
          // Mark automated ChatGPT submissions clearly without changing the original job prompt.
          const automatedPrompt = promptContext.startsWith("Linear Bridge Automated Prompt:")
            ? promptContext
            : `Linear Bridge Automated Prompt: ${promptContext}`;
          const handoffPayload = useShortcuts
            ? { conversationUrl: route.chatgptProjectUrl, prompt: automatedPrompt, handoffId }
            : { projectUrl: route.chatgptProjectUrl, conversationMode: route.chatgptConversationMode, autoSend: route.chatgptAutoSend === true, prompt: automatedPrompt, jobFile: filename };
          await fs.writeFile(handoffFile, JSON.stringify(handoffPayload, null, 2), { mode: 0o600 });
          if (route.chatgptAutoSend === true) {
            const handoffController = useShortcuts ? "Apple Shortcut" : "Playwright";
            await jobStore.transition(jobKey, "awaiting_external", { handoffFile, handoffId, note: `Automatic ${handoffController} submission launched; response processing not implemented` });
            void enqueueChatgptHandoff(() => new Promise((resolve, reject) => {
              const childArgs = useShortcuts
                ? [script, "--handoff-file", handoffFile]
                : [script, "--handoff-file", handoffFile, "--auto-send", "--keep-open"];
              const child = spawnProcess(execPath, childArgs, {
                cwd: path.resolve(PROJECT_DIR, ".."), env: env, stdio: ["ignore", "pipe", "pipe"],
              });
              child.stdout?.on("data", chunk => logger.log("[ChatGPT handoff] " + String(chunk).trimEnd()));
              child.stderr?.on("data", chunk => logger.error("[ChatGPT handoff] " + String(chunk).trimEnd()));
              child.once("error", reject);
              child.once("close", code => code === 0 ? resolve() : reject(new Error(`${handoffController} handoff exited with code ${code}`)));
            })).catch(async error => {
              logger.error("Automatic ChatGPT handoff failed:", error);
              await jobStore.transition(jobKey, "failed", { error: String(error) }).catch(e => logger.error("Unable to record ChatGPT handoff failure:", e));
            });
          } else {
            const handoffController = useShortcuts ? "Apple Shortcut" : "Playwright";
            await jobStore.transition(jobKey, "awaiting_external", { handoffFile, handoffId, note: `Supervised ${handoffController} handoff ready; run manually` });
            logger.log(`ChatGPT ${handoffController} handoff ready: ${handoffFile}`);
            logger.log(`Run: node ${script} --handoff-file ${handoffFile}`);
          }
        }
      } else {
        await jobStore.transition(jobKey, "awaiting_external", { note: "ChatGPT task saved; set CHATGPT_HANDOFF_MODE=supervised-playwright or shortcuts to prepare a browser handoff" });
      }
}
