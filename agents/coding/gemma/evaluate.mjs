#!/usr/bin/env node
// Read-only P0 evaluation, not a production Linear dispatch entrypoint.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runGemmaInventory } from "./inventory.mjs";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , workspace, ...promptWords] = process.argv;
  const prompt = promptWords.join(" ") || "Inventory the repository structure and propose a safe migration manifest. Do not edit files.";
  try {
    const result = await runGemmaInventory({
      workspace,
      prompt,
      apiKey: process.env.OPENROUTER_API_KEY,
    });
    process.stdout.write(result.text + "\n");
  } catch {
    // Never print SDK errors, which can include request headers or provider payloads.
    console.error("Gemma evaluation failed. Verify the OpenRouter API key, SDK installation, model availability, and workspace.");
    process.exitCode = 1;
  }
}
