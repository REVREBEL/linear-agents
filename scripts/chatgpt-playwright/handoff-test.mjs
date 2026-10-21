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
  // Use the currently visible ChatGPT tab, not an arbitrary initial tab.
  const chatPages = browser.pages().filter(p => {
    try { return new URL(p.url()).hostname === "chatgpt.com"; }
    catch { return false; }
  });
  const activePage = chatPages.at(-1) ?? page;
  if (new URL(activePage.url()).hostname !== "chatgpt.com") {
    throw new Error("No ChatGPT tab found. Open a new chat in the test browser.");
  }
  console.log("Current destination:", activePage.url());
  console.log("Finding ChatGPT composer...");
  // ChatGPT uses a contenteditable editor. Select a visible editable area.
  const choices = [
    activePage.locator('#prompt-textarea[contenteditable="true"]'),
    activePage.locator('[data-testid="composer-input"][contenteditable="true"]'),
    activePage.locator('[contenteditable="true"][role="textbox"]'),
    activePage.locator('[contenteditable="true"]'),
  ];
  let composer;
  for (const choice of choices) {
    const count = await choice.count();
    for (let i=0; i<count; i++) {
      const candidate = choice.nth(i);
      if (await candidate.isVisible().catch(() => false)) { composer = candidate; break; }
    }
    if (composer) break;
  }
  if (!composer) {
    throw new Error("Could not find a visible ChatGPT text composer. Ensure you are signed in and opened a new project chat.");
  }
  await composer.click();
  await composer.fill(prompt);
  const inserted = (await composer.innerText()).trim();
  if (inserted !== prompt) {
    throw new Error("Composer did not retain the prompt. Check the ChatGPT tab before retrying.");
  }
  console.log("Prompt verified in editor, NOT sent. Confirm the destination and text in the visible browser.");
  const answer = (await rl.question("Type SEND to submit, or anything else to cancel: ")).trim();
  if (answer !== "SEND") { console.log("Cancelled: prompt was not submitted."); process.exitCode = 0; }
  else {
    await composer.press("Enter");
    console.log("Submission attempted in:", activePage.url());
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
