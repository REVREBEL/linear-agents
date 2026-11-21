import test from "node:test";
import assert from "node:assert/strict";
import { createGitHubReviewClient } from "./github-review-client.mjs";
import { verifyPromotionFromGitHub } from "./promotion-verification.mjs";

const REPO = "REVREBEL/linear-agents";
const SHA = "a".repeat(40), MERGE = "b".repeat(40);
const token = "ghs_auth_test_token_with_fake_characters";
const pr = { number: 42, state: "closed", merged: true,
  head: { sha: SHA, repo: { full_name: REPO } },
  base: { repo: { full_name: REPO } }, merge_commit_sha: MERGE,
  user: { login: "coding-agent" } };
const review = { id: 2, state: "APPROVED", commit_id: SHA,
  submitted_at: "2026-11-20T07:00:00Z", user: { login: "reviewer" } };
const check = { id: 4, name: "bridge-tests", head_sha: SHA,
  status: "completed", conclusion: "success", app: { slug: "github-actions" } };
const jsonResponse = (data, { link = "", status = 200, length } = {}) => {
  const raw = Buffer.from(JSON.stringify(data));
  return new Response(raw, { status, headers: { "content-length": String(length ?? raw.length),
    ...(link ? { link } : {}) } });
};
function fixture(responder) {
  const calls = [];
  const client = createGitHubReviewClient({
    tokenProvider: async () => token,
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      calls.push({ url: parsed, options });
      assert.equal(parsed.origin, "https://api.github.com");
      assert.equal(options.headers.Authorization, "Bearer " + token);
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "GET");
      return responder(parsed);
    },
  });
  return { calls, client };
}
function route(url) {
  const path = url.pathname;
  if (path.endsWith("/pulls/42")) return jsonResponse(pr);
  if (path.endsWith("/pulls/42/reviews")) return jsonResponse([review]);
  if (path.endsWith("/check-runs")) return jsonResponse({ total_count: 1,
    check_runs: [check] });
  if (path.endsWith("/collaborators/reviewer/permission"))
    return jsonResponse({ permission: "write" });
  throw Error("unexpected GitHub REST route");
}
test("real REST client satisfies independent merged SHA, reviewer and check proof", async () => {
  const { calls, client } = fixture(route);
  const scope = { tenantId:"tenant", agentId:"agent", repositoryId:REPO, issueId:"ABR-59" };
  const result = await verifyPromotionFromGitHub({ github: client, scope,
    prNumber:42, expectedHeadSha:SHA, requiredChecks:["bridge-tests"] });
  assert.equal(result.status, "verified-after-merge");
  assert.equal(result.approval.reviewer, "reviewer");
  assert.equal(result.checks[0].checkRunId, 4);
  assert.equal(calls.filter(x => x.url.pathname.endsWith("/pulls/42")).length, 2);
  assert.equal(calls.find(x => x.url.pathname.endsWith("/check-runs"))
    .url.searchParams.get("filter"), "all");
});
test("fetches every review/check page and retains the latest run", async () => {
  const reviews = Array.from({ length: 100 }, (_, id) => ({
    ...review, id: id + 1, user:{login:"user-" + id},
  }));
  const { client } = fixture(url => {
    if (url.pathname.endsWith("/reviews")) {
      return Number(url.searchParams.get("page")) === 1
        ? jsonResponse(reviews, {link:'<https://api.github.com/next>; rel="next"'})
        : jsonResponse([review]);
    }
    if (url.pathname.endsWith("/check-runs")) return jsonResponse({
      total_count:1,check_runs:[check] });
    return route(url);
  });
  assert.equal((await client.listReviews(REPO,42)).length,101);
  assert.equal((await client.listCheckRuns(REPO,SHA)).length,1);
});
test("fails closed on truncated pagination, non-200 responses and oversized payload", async () => {
  const hundred = Array.from({length:100},()=>review);
  const denied = responder => fixture(responder).client.listReviews(REPO,42);
  await assert.rejects(denied(() => jsonResponse(hundred)), /unavailable/);
  await assert.rejects(denied(() => jsonResponse([], { status: 403 })), /unavailable/);
  await assert.rejects(denied(() => jsonResponse([], { length: 999999 })), /unavailable/);
  await assert.rejects(denied(() => jsonResponse(hundred, {
    link:'<https://api.github.com/more>; rel="next"',
  })), /unavailable/);
});
test("never issues calls for malformed repo, SHA, PR or login", async () => {
  const { calls, client } = fixture(route);
  for (const invalid of ["../../owner", "other/../../repo", "owner/repo;evil"])
    await assert.rejects(client.getPullRequest(invalid,42),/unavailable/);
  await assert.rejects(client.getPullRequest(REPO,-1),/unavailable/);
  await assert.rejects(client.listCheckRuns(REPO,"invalid-sha"),/unavailable/);
  await assert.rejects(client.getCollaboratorPermission(REPO,"../unsafe"),/unavailable/);
  assert.equal(calls.length,0);
});
test("credential failures and fetch exception cannot expose tokens", async () => {
  const bad = createGitHubReviewClient({ tokenProvider:async()=>token,
    fetchImpl:async()=>{throw Error("secret: " + token);} });
  await assert.rejects(bad.getPullRequest(REPO,42),error=>
    error.code==="EGITHUB_REVIEW_CLIENT_DENIED" && !error.message.includes(token));
  const noToken = createGitHubReviewClient({tokenProvider:async()=>null});
  await assert.rejects(noToken.getPullRequest(REPO,42),/unavailable/);
});

test("incomplete or contradictory CI totals fail without passing stale checks", async () => {
  const { client } = fixture(url => {
    if (url.pathname.endsWith("/check-runs"))
      return jsonResponse({ total_count: 2, check_runs: [check] });
    return route(url);
  });
  await assert.rejects(client.listCheckRuns(REPO,SHA), /unavailable/);
  const inconsistent = fixture(url => {
    if (url.pathname.endsWith("/check-runs"))
      return jsonResponse({ total_count: -1, check_runs: [check] });
    return route(url);
  });
  await assert.rejects(inconsistent.client.listCheckRuns(REPO,SHA), /unavailable/);
});

test("credential provider errors are redacted", async () => {
  const client = createGitHubReviewClient({
    tokenProvider: async () => { throw Error("credential " + token); },
  });
  await assert.rejects(client.getPullRequest(REPO, 42), error =>
    error.code === "EGITHUB_REVIEW_CLIENT_DENIED" && !error.message.includes(token));
});

test("oversized response without content length is cancelled while streaming", async () => {
  let cancelled = false;
  const client = createGitHubReviewClient({
    tokenProvider: async () => token,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(70000)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(client.getPullRequest(REPO, 42), /unavailable/);
  assert.equal(cancelled, true);
});
