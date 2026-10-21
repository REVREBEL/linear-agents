#!/usr/bin/env node
// Manual, supervised ChatGPT Project navigation and prompt submission test.
// Not wired to incoming Linear jobs or background services.
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir } from "node:fs/promises";

function usage() {
  console.error('Usage: npm run chatgpt:playwright -- --project-url "https://chatgpt.com/g/..." --prompt "test message"');
  process.exit(2);
}
const args = process.argv.slice(2);
function value(flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index+1]; }
const projectUrl = value("--project-url");
const prompt = value("--prompt");
if (!projectUrl || !prompt || args.includes("--help")) usage();
const url = new URL(projectUrl);
if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || !url.pathname.startsWith("/g/g-p-")) {
  console.error("Refusing non-ChatGPT Project URL. Copy the URL from your ChatGPT Project.");
  process.exit(2);
}
if (prompt.length > 8000) { console.error("Test prompt too long."); process.exit(2); }
const profile = resolve(homedir(), ".linear-agents-chatgpt-playwright");
await mkdir(profile, { recursive: true, mode: 0o700 });
const rl = createInterface({ input: stdin, output: stdout });
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: "chrome",
    viewport: null,
  });
  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log("Opened ChatGPT Project:", url.href);
  console.log("Sign in if necessary, and MANUALLY start a new chat inside this project.");
  await rl.question("After checking the project and opening a new chat, press Return to continue (Ctrl+C to cancel): ");
  if (new URL(page.url()).hostname !== "chatgpt.com") throw new Error("Browser is no longer on ChatGPT.");
  const composer = page.locator('#prompt-textarea[contenteditable="true"], [data-testid="composer-input"][contenteditable="true"], [contenteditable="true"][role="textbox"]').first();
  await composer.waitFor({ state: "visible", timeout: 15000 });
  await composer.fill(prompt);
  console.log("Prompt filled, NOT sent. Confirm the destination and text in the visible browser.");
  const answer = (await rl.question("Type SEND to submit, or anything else to cancel: ")).trim();
  if (answer !== "SEND") { console.log("Cancelled: prompt was not submitted."); process.exitCode = 0; }
  else {
    await composer.press("Enter");
    console.log("Submission attempted in:", page.url());
    console.log("Check that the message appears in the intended project chat.");
  }
  await rl.question("Press Return to close this test browser: ");
} catch (error) {
  console.error("Playwright test failed:", error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  await browser?.close();
}
