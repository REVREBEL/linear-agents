#!/usr/bin/env node
// Manual, supervised ChatGPT Project navigation and prompt submission test.
// Not wired to incoming Linear jobs or background services.
import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile } from "node:fs/promises";

function usage() {
  console.error('Usage: npm run chatgpt:playwright -- --project-url "https://chatgpt.com/g/..." --prompt "test message" [--keep-open] OR --handoff-file /path/to/handoff.json');
  process.exit(2);
}
const args = process.argv.slice(2);
function value(flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index+1]; }
const handoffFile = value("--handoff-file");
let projectUrl = value("--project-url");
let prompt = value("--prompt");
let conversationMode = value("--conversation-mode");
let autoSend = args.includes("--auto-send");
if (handoffFile) {
  const handoff = JSON.parse(await readFile(resolve(handoffFile), "utf8"));
  projectUrl = handoff.projectUrl;
  prompt = handoff.prompt;
  conversationMode = handoff.conversationMode || conversationMode;
  autoSend = autoSend || handoff.autoSend === true;
}
const keepOpen = args.includes("--keep-open");
conversationMode ||= (new URL(projectUrl || "https://chatgpt.com").pathname.includes("/c/") ? "reuse-existing" : "new-per-issue");
if (!["reuse-existing", "new-per-issue"].includes(conversationMode)) usage();
if (autoSend && conversationMode !== "reuse-existing") throw Error("--auto-send requires reuse-existing to prevent sending to an unverified new chat");
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
    chromiumSandbox: true,
  });
  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log("Google Chrome selected (Playwright channel: chrome).");
  console.log("Opened ChatGPT Project:", url.href);
  console.log(conversationMode === "reuse-existing" ? "Sign in if necessary and verify the existing conversation is open. Do not start a new chat." : "Sign in if necessary, and MANUALLY start a new chat inside this project.");
  if (!autoSend) await rl.question(conversationMode === "reuse-existing" ? "After confirming the intended existing conversation is open, press Return (Ctrl+C to cancel): " : "After checking the project and opening a new chat, press Return to continue (Ctrl+C to cancel): ");
  // Use the currently visible ChatGPT tab, not an arbitrary initial tab.
  const chatPages = browser.pages().filter(p => {
    try { return new URL(p.url()).hostname === "chatgpt.com"; }
    catch { return false; }
  });
  const activePage = chatPages.find(p => p === page) ?? chatPages.at(-1) ?? page;
  if (new URL(activePage.url()).hostname !== "chatgpt.com") {
    throw new Error("No ChatGPT tab found. Open a new chat in the test browser.");
  }
  console.log("Current destination:", activePage.url());
  if (autoSend && new URL(activePage.url()).pathname !== url.pathname) throw Error("Refusing automatic send: existing conversation URL does not match configured target");
  await activePage.bringToFront();
  console.log("Finding ChatGPT composer...");
  console.log("Page title:", await activePage.title().catch(() => "(unavailable)"));
  // ChatGPT hydrates the composer asynchronously after DOMContentLoaded.
  // Poll visible editors rather than checking once and immediately exiting.
  const selectors = [
    '#prompt-textarea[contenteditable="true"]',
    '[data-testid="composer-input"][contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ];
  let composer;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !composer) {
    for (const selector of selectors) {
      const candidate = activePage.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) {
        composer = candidate;
        break;
      }
    }
    if (!composer) await activePage.waitForTimeout(750);
  }
  if (!composer) {
    const currentUrl = activePage.url();
    const title = await activePage.title().catch(() => "(unavailable)");
    throw new Error(`Composer not visible after 45s. Current URL: ${currentUrl}; title: ${title}. Check that the dedicated Chrome profile is signed in and the conversation finished loading.`);
  }
  await composer.click();
  await composer.fill(prompt);
  console.log("Editor received input, checking value...");
  const inserted = (await composer.innerText()).trim();
  if (inserted !== prompt) {
    throw new Error("Composer did not retain the prompt. Check the ChatGPT tab before retrying.");
  }
  console.log("Prompt verified in editor.");
  const answer = autoSend ? "SEND" : (await rl.question("Type SEND to submit, or anything else to cancel: ")).trim();
  if (answer !== "SEND") { console.log("Cancelled: prompt was not submitted."); process.exitCode = 0; }
  else {
    await composer.press("Enter");
    console.log("Submission attempted in:", activePage.url());
    console.log("Check that the message appears in the intended project chat.");
  }
  if (autoSend && !keepOpen) {
    console.log("Automatic prompt submission attempted; response monitoring and Linear callback are not implemented.");
  } else if (keepOpen) {
    console.log("Keeping Chrome open while this process runs. Press Ctrl+C to close the test session.");
    rl.close();
    await new Promise(resolve => {
      process.once("SIGINT", resolve);
      browser.once("close", resolve);
    });
  } else {
    await rl.question("Press Return to close this test browser (or use --keep-open next time): ");
  }
} catch (error) {
  console.error("Playwright handoff failed:", error.message);
  process.exitCode = 1;
} finally {
  rl.close();
  if (browser && keepOpen) {
    // Preserve the interactive Chrome session even when navigation, login,
    // editor discovery or prompt submission throws. Only explicit browser
    // close / termination should end a keep-open handoff.
    console.log("Chrome remains open for inspection. Close its window or stop this process to finish.");
    if (browser.pages().some(page => !page.isClosed())) {
      await new Promise(resolve => {
        browser.once("close", resolve);
      });
    }
  } else {
    await browser?.close();
  }
}
