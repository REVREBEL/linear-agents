import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateRemoteJob, cleanupRemoteInbox, excludeAgentRuntime } from "./agents/trae/scripts/launch.mjs";

function mockFs() {
  return {
    async realpath(p) { return path.resolve(p); },
    async stat() { return { isDirectory: () => true }; },
  };
}
const job = {
  agent: "trae",
  jobId: "delivery-123",
  repository: "REVREBEL/linear-agents",
  projectsRoot: "/Users/test/rebel",
  projectScope: "apps/docs",
  launchFromScope: true,
  agentSessionId: "01234567-89ab-cdef-0123-456789abcdef",
  accessToken: "fake-non-secret",
  prompt: "Implement the issue",
};
test("Mac runner resolves actual repository and trusted project scope", async () => {
  assert.deepEqual(await validateRemoteJob(job, mockFs()), {
    root: "/Users/test/rebel/linear-agents",
    workspace: "/Users/test/rebel/linear-agents/apps/docs",
  });
});
test("Mac runner refuses unrelated repos and scope traversal before job creation", async () => {
  await assert.rejects(() => validateRemoteJob({ ...job, repository: "other/project" }, mockFs()), /Invalid remote job identity/);
  await assert.rejects(() => validateRemoteJob({ ...job, projectScope: "../../outside" }, mockFs()), /escaped repository/);
  await assert.rejects(() => validateRemoteJob({ ...job, accessToken: "" }, mockFs()), /Missing agent access token/);
  await assert.rejects(() => validateRemoteJob({ ...job, jobId: "../../command" }, mockFs()), /Invalid remote job identity/);
});
test("Mac runner refuses symlink repository outside trusted root", async () => {
  const fsApi = mockFs();
  fsApi.realpath = async value => value.endsWith("linear-agents") ? "/tmp/outside" : path.resolve(value);
  await assert.rejects(() => validateRemoteJob(job, fsApi), /escaped configured root/);
});

test("Git runtime exclusion is installed before writing Mac task files", async () => {
  let current = "";
  let appendCount = 0;
  const fsApi = {
    async mkdir() {},
    async readFile() { return current; },
    async appendFile(file, content) { current += content; appendCount++; },
  };
  const git = async (bin, argv) => argv.includes("rev-parse")
    ? { stdout: "/tmp/repo/.git/info/exclude\\n" } : { stdout: "" };
  await excludeAgentRuntime("/tmp/repo", fsApi, git);
  await excludeAgentRuntime("/tmp/repo", fsApi, git);
  assert.match(current, /\\/\\.linear-agent\\//);
  assert.equal(appendCount, 1);
});

test("remote cleanup removes only the validated job's inbox file", async () => {
  const removed = [];
  const fsApi = {
    async realpath(value) { return path.resolve(value); },
    async unlink(value) { removed.push(value); },
  };
  const cleanup = {
    operation: "cleanup", agent: "trae",
    projectsRoot: "/Users/test/rebel",
    repository: "REVREBEL/linear-agents",
    projectId: "project-1", jobId: "delivery-1"
  };
  assert.equal(await cleanupRemoteInbox(cleanup, fsApi), true);
  assert.deepEqual(removed, ["/Users/test/rebel/linear-agents/.linear-agent/projects/project-1/inbox/delivery-1.json"]);
  await assert.rejects(() => cleanupRemoteInbox({ ...cleanup, jobId: "../../etc" }, fsApi), /Invalid remote cleanup/);
  await assert.rejects(() => cleanupRemoteInbox({ ...cleanup, projectId: "../outside" }, fsApi), /Invalid remote cleanup/);
});
