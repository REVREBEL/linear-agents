import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scripts = [
  "scripts/bridge.sh",
  "scripts/platform-setup.sh",
  "scripts/macos/bridge.sh",
  "scripts/macos/install-launchagent.sh",
  "scripts/linux/bridge.sh",
  "scripts/linux/install-systemd.sh",
  "scripts/linux/install-github-event-publisher.sh",
  "scripts/linux/run-github-event-publisher.sh",
];
test("all platform Bash scripts parse", () => {
  for (const script of scripts) {
    const result = spawnSync("bash", ["-n", path.join(root, script)], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});
test("npm bridge commands use platform launcher", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  for (const operation of ["load", "unload", "restart", "status", "doctor"]) {
    assert.equal(pkg.scripts[`bridge:${operation}`], `bash scripts/bridge.sh ${operation}`);
  }
  assert.equal(pkg.scripts["bridge:setup"], "bash scripts/platform-setup.sh");
});
test("ChatGPT CLI deployment shares the registered ChatGPT Linear app credentials", () => {
  const script = readFileSync(path.join(root, "scripts/with-env.sh"), "utf8");
  assert.match(script, /if \\[\\[ "\\$\\{agent\\}" == "chatgpt-cli" \\]\\]; then credential_prefix="CHATGPT"; fi/);
  assert.match(script, /sourced_key="\\$\\{credential_prefix\\}_\\$\\{key\\}"/);
  assert.match(script, /require "\\$\\{credential_prefix\\}_LINEAR_CLIENT_ID"/);
  assert.match(script, /require "\\$\\{credential_prefix\\}_LINEAR_CLIENT_SECRET"/);
  assert.match(script, /require "\\$\\{credential_prefix\\}_LINEAR_WEBHOOK_SECRET"/);
});
test("Linux installers default to print-only and identify the existing unit", () => {
  if (process.platform !== "linux") return;
  for (const script of ["install-systemd.sh", "install-github-event-publisher.sh"]) {
    const output = execFileSync("bash", [path.join(root, "scripts/linux", script)], {
      encoding: "utf8",
      env: { ...process.env, BRIDGE_INSTALL_ROOT: root },
    });
    assert.match(output, /agent-bridge/);
  }
});

test("Linux print-only installers work before production directory exists and quote paths with spaces", () => {
  if (process.platform !== "linux") return;
  const rootWithSpaces = "/tmp/bridge preview dir";
  for (const file of ["install-systemd.sh", "install-github-event-publisher.sh"]) {
    const result = spawnSync("bash", [path.join(root, "scripts/linux", file)], {
      encoding: "utf8", env: { ...process.env, BRIDGE_INSTALL_ROOT: rootWithSpaces, BRIDGE_USER_HOME: "/tmp/bridge account" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WorkingDirectory="\/tmp\/bridge preview dir"/);
    assert.match(result.stdout, /Environment="HOME=\/tmp\/bridge account"/);
    assert.match(result.stdout, /ExecStart=\/usr\/bin\/bash "\/tmp\/bridge preview dir\/scripts\//);
  }
});
test("Linux status uses configured loopback host and port", () => {
  if (process.platform !== "linux") return;
  const temp = mkdtempSync(path.join(os.tmpdir(), "bridge-status-test-"));
  try {
    writeFileSync(path.join(temp, "bridge.env"), "BRIDGE_HOST=localhost\nBRIDGE_PORT=9091\n");
    for (const name of ["systemctl", "curl", "sudo"]) {
      writeFileSync(path.join(temp, name), `#!/bin/sh\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*"\n`, { mode: 0o755 });
    }
    const result = spawnSync("bash", [path.join(root, "scripts/bridge.sh"), "status"], {
      encoding: "utf8",
      env: { ...process.env, LINEAR_AGENTS_ENV_FILE: path.join(temp, "bridge.env"), PATH: `${temp}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /http:\/\/localhost:9091\/health/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
test("Linux restart uses the exact passwordless sudoers unit argument", () => {
  if (process.platform !== "linux") return;
  const temp = mkdtempSync(path.join(os.tmpdir(), "bridge-restart-test-"));
  try {
    for (const name of ["sudo", "systemctl"]) {
      writeFileSync(path.join(temp, name), "#!/bin/sh\nprintf '%s\\n' \"$*\"\n", { mode: 0o755 });
    }
    const result = spawnSync("bash", [path.join(root, "scripts/bridge.sh"), "restart"], {
      encoding: "utf8", env: { ...process.env, PATH: `${temp}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(),
      process.getuid?.() === 0 ? "restart agent-bridge" : "-n systemctl restart agent-bridge");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("Linux handoff source does not claim an unsupported automatic GitHub review", () => {
  const src = readFileSync(path.join(root, "linear-agent-bridge/agent-bridge.mjs"), "utf8");
  const guard = src.indexOf('process.env.CHATGPT_REVIEW_MODE !== "inbox" &&');
  const claim = src.indexOf('const claimFile = path.join(eventDir');
  assert.ok(guard !== -1 && guard < claim, "Linux unsupported-mode guard must precede delivery claim");
  const tokenGuard = src.indexOf('CHATGPT_REVIEW_INBOX_TOKEN.length < 32');
  assert.ok(tokenGuard !== -1 && tokenGuard < claim, "Inbox mode must validate the consumer token before claiming delivery");
  assert.match(src, /Linux ChatGPT browser\/Shortcuts handoff unsupported/);
});

test("Linux bridge status uses systemctl and local health without modifying services", () => {
  if (process.platform !== "linux") return;
  const temp = mkdtempSync(path.join(os.tmpdir(), "bridge-platform-test-"));
  try {
    for (const name of ["systemctl", "curl", "sudo"]) {
      const body = `#!/bin/sh\nprintf '%s %s\\n' ${JSON.stringify(name)} "$*"\n`;
      writeFileSync(path.join(temp, name), body, { mode: 0o755 });
      chmodSync(path.join(temp, name), 0o755);
    }
    const envFile = path.join(temp, "bridge.env");
    writeFileSync(envFile, "BRIDGE_HOST=127.0.0.1\nBRIDGE_PORT=8788\n");
    const result = spawnSync("bash", [path.join(root, "scripts/bridge.sh"), "status"], {
      encoding: "utf8",
      env: { ...process.env, LINEAR_AGENTS_ENV_FILE: envFile, PATH: `${temp}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /systemctl status agent-bridge --no-pager/);
    assert.match(result.stdout, /curl --fail --silent --show-error --max-time 5 http:\/\/127.0.0.1:8788\/health/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});


test("ChatGPT CLI KV setup provisions the dedicated namespace and .env binding", () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "bridge-kv-test-"));
  try {
    const envFile = path.join(temp, ".env");
    const namespaceId = "b".repeat(32);
    writeFileSync(envFile, "CHATGPT_CLI_KV_NAMESPACE_ID=\n");
    const mockFetch = path.join(temp, "mock-fetch.mjs");
    writeFileSync(mockFetch, `
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  if (!String(url).includes("/storage/kv/namespaces")) throw Error("Unexpected URL");
  if (method === "GET") return { ok: true, success: true, json: async () =>
    ({ success: true, result: [], result_info: { total_pages: 1 } }) };
  if (method === "POST") {
    const body = JSON.parse(options.body);
    if (body.title !== "LINEAR_CHATGPT_CLI_DATA") throw Error("Wrong namespace title");
    return { ok: true, json: async () =>
      ({ success: true, result: { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } }) };
  }
  throw Error("Unexpected Cloudflare call: " + method);
};
`);
    const env = {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "test-only-fake-token",
      CHATGPT_CLI_PREFIX: "chatgpt-cli",
      REPO_ROOT: temp,
      LINEAR_AGENTS_ENV_FILE: envFile,
    };
    const result = spawnSync(process.execPath, [
      "--import", mockFetch, path.join(root, "scripts/setup-kv.mjs"), "chatgpt-cli",
    ], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created KV namespace LINEAR_CHATGPT_CLI_DATA/);
    assert.match(readFileSync(envFile, "utf8"), new RegExp(`CHATGPT_CLI_KV_NAMESPACE_ID="[a-f0-9]{32}"`));
    assert.ok(readFileSync(envFile, "utf8").includes(namespaceId));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
