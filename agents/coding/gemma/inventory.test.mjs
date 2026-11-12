import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeReadOnlyInventoryTools, runGemmaInventory, GEMMA_MODEL } from "./inventory.mjs";
import { runOpenRouterAgent } from "../../../integrations/openrouter/agent-runtime.mjs";

function fakeSdk() {
  let received;
  const sdk = {
    z: { string: () => ({}), object: value => value },
    tool: spec => spec,
    stepCountIs: n => ({ maxSteps: n }),
    OpenRouter: class {
      constructor({ apiKey }) { assert.equal(apiKey, "test-only"); }
      callModel(input) {
        received = input;
        return { getText: async () => "Inventory ready" };
      }
    },
  };
  return { sdk, getReceived: () => received };
}
test("Gemma selects exact model, bounded loop, read-only tools and no fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemma-test-"));
  try {
    await writeFile(path.join(root, "README.md"), "Safe source");
    const { sdk, getReceived } = fakeSdk();
    const result = await runGemmaInventory({ workspace: root, prompt: "Inventory this", apiKey: "test-only", sdk });
    assert.equal(result.model, GEMMA_MODEL);
    assert.equal(result.text, "Inventory ready");
    assert.equal(getReceived().stopWhen[0].maxSteps, 8);
    assert.deepEqual(getReceived().tools.map(t => t.name), ["list_directory", "read_file"]);
    const list = await getReceived().tools[0].execute({ directory: "root" });
    assert.deepEqual(list, [{ name: "README.md", kind: "file" }]);
    assert.equal(await getReceived().tools[1].execute({ file: "README.md" }), "Safe source");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("Hidden, traversal, secret, symlink and oversized files are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gemma-test-"));
  try {
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "ok.ts"), "export {}");
    await writeFile(path.join(root, ".env"), "SECRET=NEVER");
    await writeFile(path.join(root, "provider-token.txt"), "NEVER");
    await writeFile(path.join(root, "big.txt"), "a".repeat(32769));
    await symlink(path.join(root, ".env"), path.join(root, "src", "link.txt"));
    const tools = await makeReadOnlyInventoryTools(root, fakeSdk().sdk);
    for (const file of [".env", "../etc/passwd", "provider-token.txt", "big.txt", "src/link.txt", "/etc/passwd"]) {
      await assert.rejects(tools[1].execute({ file }));
    }
    assert.equal(await tools[1].execute({ file: "src/ok.ts" }), "export {}");
    const listed = await tools[0].execute({ directory: "root" });
    assert.ok(!listed.some(entry => entry.name === ".env" || entry.name === "provider-token.txt"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("SDK runtime rejects unsafe inputs before provider call", async () => {
  const { sdk } = fakeSdk();
  await assert.rejects(runOpenRouterAgent({ apiKey: "", model: GEMMA_MODEL, input: "test", sdk }));
  await assert.rejects(runOpenRouterAgent({ apiKey: "test-only", model: "invalid", input: "test", sdk }));
  await assert.rejects(runOpenRouterAgent({ apiKey: "test-only", model: GEMMA_MODEL, input: "test", maxSteps: 100, sdk }));
});
