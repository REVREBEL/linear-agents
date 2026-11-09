import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { validateRemoteJob } from "./agents/trae/scripts/launch.mjs";

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
