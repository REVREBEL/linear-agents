import test from "node:test";
import assert from "node:assert/strict";
import { chooseExecutionHost, configuredProjectRoots, makeRemoteRoute, validateSshSettings } from "./host-routing.mjs";
import { buildSshArgs } from "./ssh-dispatch.mjs";

test("no Agent Location remains Ubuntu-local for backward compatibility", () => {
  assert.deepEqual(chooseExecutionHost({}), { ok: true, host: "bridge-server", source: "default" });
  assert.equal(chooseExecutionHost({ agentLocation: null }).host, "bridge-server");
});

test("Macos label routes Trae onto Mac, while bridge-server stays on Ubuntu", () => {
  for (const name of ["Macos", "mac", "agent-location:mac"]) {
    assert.equal(chooseExecutionHost({ agentLocation: name }).host, "macos");
  }
  for (const name of ["Bridge Server", "bridge-server", "agent-location:bridge-server"]) {
    assert.equal(chooseExecutionHost({ agentLocation: name }).host, "bridge-server");
  }
  assert.equal(chooseExecutionHost({ agentLocation: "unknown" }).ok, false);
});

test("linux root explicitly overrides legacy PROJECTS_ROOT, Mac path remains separate", () => {
  assert.deepEqual(configuredProjectRoots({
    LINUX_PROJECTS_ROOT: "/home/agent-bridge/rebel",
    OSX_PROJECTS_ROOT: "/Users/example/rebel",
    PROJECTS_ROOT: "/ignored",
  }), { linux: "/home/agent-bridge/rebel", mac: "/Users/example/rebel" });
});

test("remote route resolves trusted repository scope without requiring it on Ubuntu", () => {
  const r = makeRemoteRoute({ root: "/Users/example/rebel", repository: "REVREBEL/linear-agents", scope: "src" });
  assert.equal(r.repositoryRoot, "/Users/example/rebel/linear-agents");
  assert.equal(r.launchDirectory, "/Users/example/rebel/linear-agents");
  assert.equal(makeRemoteRoute({ root: "/Users/example/rebel", repository: "REVREBEL/linear-agents", scope: "src", launchFromScope: true }).launchDirectory, "/Users/example/rebel/linear-agents/src");
  assert.throws(() => makeRemoteRoute({ root: "/Users/example/rebel", repository: "REVREBEL/linear-agents", scope: "../../etc" }), /escapes/);
  assert.throws(() => makeRemoteRoute({ root: "/", repository: "REVREBEL/linear-agents" }), /absolute/);
  assert.throws(() => makeRemoteRoute({ root: "/Users/example/rebel", repository: "OTHER/linear-agents" }), /Invalid approved/);
});

test("SSH host and command are fixed and never interpolate the issue payload", () => {
  const env = {
    MAC_SSH_HOST: "mac-agent",
    OSX_PROJECTS_ROOT: "/Users/example/rebel",
    MAC_NODE_BIN: "/opt/homebrew/bin/node",
  };
  assert.equal(validateSshSettings(env).host, "mac-agent");
  const args = buildSshArgs(env);
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.equal(args[args.length - 2], "mac-agent");
  assert.match(args.at(-1), /agents\/trae\/scripts\/launch\.mjs/);
  assert.throws(() => validateSshSettings({ ...env, MAC_SSH_HOST: "-oProxyCommand=evil" }), /trusted SSH/);
  assert.throws(() => validateSshSettings({ ...env, MAC_RUNNER_PATH: "/tmp/test';touch /tmp/x" }), /trusted macOS/);
});
