#!/usr/bin/env node
// Unattended, browser-based ChatGPT handoff on Ubuntu.
// Submission is not evidence of task completion or successful code review.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requirePlaywright = createRequire(new URL("../../../../scripts/chatgpt-playwright/package.json", import.meta.url));
const defaultState = path.join(os.homedir(), ".config", "linear-agents", "chatgpt-storage-state.json");

export function validateHandoff(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) throw Error("Missing handoff");
  const raw = job.conversationUrl || job.projectUrl;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" ||
      !/^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(url.pathname) ||
      url.search || url.hash || url.username || url.password) {
    throw Error("Headless submission requires the exact existing ChatGPT Project conversation URL");
  }
  if (job.conversationMode && job.conversationMode !== "reuse-existing") {
    throw Error("Headless handoff requires reuse-existing conversation mode");
  }
  if (typeof job.prompt !== "string" || !job.prompt.trim() || job.prompt.length > 8000) {
    throw Error("Missing or oversized ChatGPT prompt");
  }
  if (job.autoSend !== true) throw Error("Automatic submission must be explicitly enabled");
  return { url: url.href, prompt: job.prompt };
}

export async function validateStorageState(file, fsApi = fs) {
  if (!path.isAbsolute(file)) throw Error("CHATGPT_STORAGE_STATE must be an absolute file path");
  const stats = await fsApi.stat(file);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) {
    throw Error("ChatGPT storage state must be a private regular file (chmod 600)");
  }
  const state = JSON.parse(await fsApi.readFile(file, "utf8"));
  if (!Array.isArray(state.cookies) || !Array.isArray(state.origins) || !state.cookies.length) {
    throw Error("ChatGPT storage state has no saved browser cookies");
  }
  return state;
}

export async function preflightChatgptHeadless({ storageStatePath = process.env.CHATGPT_STORAGE_STATE || defaultState } = {}) {
  await validateStorageState(storageStatePath);
  requirePlaywright.resolve("playwright");
  return true;
}

export async function submitChatgptHeadless({ handoff, storageStatePath = process.env.CHATGPT_STORAGE_STATE || defaultState,
  playwright, fsApi = fs, logger = console }) {
  const { url, prompt } = validateHandoff(handoff);
  await validateStorageState(storageStatePath, fsApi);
  const engine = playwright || requirePlaywright("playwright");
  const browser = await engine.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ storageState: storageStatePath });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (new URL(page.url()).origin !== "https://chatgpt.com" ||
        new URL(page.url()).pathname !== new URL(url).pathname) {
      throw Error("ChatGPT redirected away from the expected existing conversation (authentication may have expired)");
    }
    const editor = page.locator('#prompt-textarea[contenteditable="true"], [data-testid="composer-input"][contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 30000 });
    await editor.fill(prompt);
    if (!(await editor.innerText()).trim()) throw Error("ChatGPT composer did not accept the prompt");
    await editor.press("Enter");
    logger.log("ChatGPT headless: submission attempted in verified conversation; completion is not confirmed");
    return { submitted: true, conversationUrl: url };
  } finally {
    await browser.close();
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--handoff-file") {
    throw Error("Usage: node launch.mjs --handoff-file /absolute/path/to/handoff.json");
  }
  const filename = path.resolve(args[1]);
  const handoff = JSON.parse(await fs.readFile(filename, "utf8"));
  await submitChatgptHeadless({ handoff });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error("ChatGPT headless handoff failed:", error.message); process.exitCode = 1; });
}
