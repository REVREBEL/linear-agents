import { githubAppHomePage } from "../../shared/github-app-homepage";
import { DurableObject } from "cloudflare:workers";
import { issueAgentLocation, type LinearIssueLabel } from "../../shared/agent-location";
import { coordinateWebhook, retryPendingWebhooks, routeWebhookToCoordinator, routeCompleteToCoordinator, onceDeliveryActivity } from "../../shared/delivery-coordinator";
import { ReauthorizationRequiredError } from "../../shared/oauth-errors";
import { getInstallation } from "../../shared/oauth-installation";

import { serveBridgeAccessToken } from "../../shared/bridge-access-token";

interface Env {
  LINEAR_DATA: KVNamespace;
  DELIVERY_COORDINATOR: DurableObjectNamespace;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_REDIRECT_URI: string;
  LINEAR_SCOPES: string;
  BRIDGE_URL: string;
  BRIDGE_SHARED_SECRET: string;
  SERVICE_NAME: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string | string[];
  refresh_token?: string;
}

interface LinearInstallation {
  organizationId: string;
  organizationName?: string;
  appUserId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string | string[];
  installedAt: string;
}

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);

      // GitHub App traffic uses a dedicated hostname and webhook secret.
      // Never interpret GitHub requests as Linear OAuth or Linear webhooks.
      if (url.hostname.startsWith("github-")) {
        if (request.method === "GET" && url.pathname === "/") {
          return githubAppHomePage("antigravity");
        }
        if (request.method === "POST" && url.pathname === "/webhook") {
          if (!env.GITHUB_WEBHOOK_SECRET) return jsonResponse({ ok: false, error: "GitHub webhook secret not configured" }, 503);
          const signature = request.headers.get("x-hub-signature-256") || "";
          const event = request.headers.get("x-github-event");
          const delivery = request.headers.get("x-github-delivery");
          if (!/^sha256=[0-9a-f]{64}$/.test(signature) || !event || !delivery) {
            return jsonResponse({ ok: false, error: "Invalid GitHub webhook headers" }, 401);
          }
          const body = await request.arrayBuffer();
          const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
          const digest = await crypto.subtle.sign("HMAC", key, body);
          const expected = new Uint8Array(digest);
          const supplied = new Uint8Array(signature.slice(7).match(/../g)!.map(part => parseInt(part, 16)));
          let mismatch = 0;
          for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ supplied[i];
          if (mismatch !== 0) return jsonResponse({ ok: false, error: "Invalid GitHub webhook signature" }, 401);
          // Forward only the authenticated event and minimum required metadata.
          // Do not expose GitHub webhook secrets or installation credentials to the bridge.
          let payload: unknown;
          try { payload = JSON.parse(new TextDecoder().decode(body)); }
          catch { return jsonResponse({ ok: false, error: "Invalid GitHub JSON" }, 400); }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return jsonResponse({ ok: false, error: "Invalid GitHub event" }, 400);
          }
          if (event === "pull_request" && !["opened", "reopened", "synchronize", "ready_for_review", "closed", "converted_to_draft", "edited"].includes((payload as { action?: string }).action || "")) {
            return jsonResponse({ ok: true, ignored: true, event, delivery }, 200);
          }
          if (event === "issue_comment" && !["created", "edited"].includes((payload as { action?: string }).action || "")) {
            return jsonResponse({ ok: true, ignored: true, event, delivery }, 200);
          }
          if (event !== "pull_request" && event !== "issue_comment" && event !== "ping") {
            return jsonResponse({ ok: true, ignored: true, event }, 200);
          }
          const bridgeUrl = new URL(env.BRIDGE_URL);
          bridgeUrl.pathname = "/github/events";
          bridgeUrl.search = "";
          let upstream: Response;
          try {
            upstream = await fetch(bridgeUrl.toString(), {
              method: "POST",
              headers: { "content-type": "application/json", "authorization": `Bearer ${env.BRIDGE_SHARED_SECRET}`, "x-github-agent": "antigravity" },
              body: JSON.stringify({ event, delivery, payload }),
              signal: AbortSignal.timeout(10000),
            });
          } catch {
            return jsonResponse({ ok: false, error: "GitHub event bridge unavailable" }, 503);
          }
          if (!upstream.ok) {
            return jsonResponse({ ok: false, error: "GitHub event bridge rejected delivery", status: upstream.status }, 503);
          }
          return jsonResponse({ ok: true, accepted: true, event, delivery }, 202);
        }
        if (url.pathname === "/oauth/callback") {
          return jsonResponse({ ok: false, error: "GitHub OAuth callback not configured; App installation tokens do not require user OAuth" }, 501);
        }
        return jsonResponse({ ok: false, error: "Not found" }, 404);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(homePage(url.origin, env.SERVICE_NAME));
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: env.SERVICE_NAME || "linear-agent-worker",
        });
      }

      // Authenticated synthetic transport check. Never routes through Linear's
      // webhook handler, coordinator, job ledger, or agent dispatch.
      if (request.method === "POST" && url.pathname === "/diagnostics/probe") {
        if (!env.BRIDGE_SHARED_SECRET ||
            request.headers.get("authorization") !== `Bearer ${env.BRIDGE_SHARED_SECRET}`) {
          return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
        }
        const probeId = request.headers.get("x-bridge-probe-id");
        if (!probeId || !/^[a-f0-9-]{36}$/i.test(probeId)) {
          return jsonResponse({ ok: false, error: "Invalid probe ID" }, 400);
        }
        const bridgeUrl = new URL(env.BRIDGE_URL);
        bridgeUrl.pathname = "/diagnostics/probe";
        bridgeUrl.search = "";
        const bridgeResponse = await fetch(bridgeUrl.toString(), {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.BRIDGE_SHARED_SECRET}`,
            "x-bridge-probe-id": probeId,
            "x-bridge-worker": env.SERVICE_NAME,
          },
          signal: AbortSignal.timeout(8000),
        });
        const payload: unknown = await bridgeResponse.json().catch(() => null);
        const data = payload !== null && typeof payload === "object" && !Array.isArray(payload)
          ? payload as Record<string, unknown> : null;
        if (!bridgeResponse.ok || data?.probeId !== probeId || data?.ok !== true || data?.service !== "local-linear-agent-router") {
          return jsonResponse({ ok: false, stage: "bridge", status: bridgeResponse.status }, 502);
        }
        return jsonResponse({ ok: true, stage: "bridge", probeId, worker: env.SERVICE_NAME, bridge: data.service });
      }

      if (request.method === "POST" && url.pathname === "/bridge/access-token") {
        return serveBridgeAccessToken(request, env);
      }

      if (request.method === "GET" && url.pathname === "/install") {
        return beginOAuth(env);
      }

      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        return handleOAuthCallback(request, env);
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        return routeWebhookToCoordinator(
          request,
          env.DELIVERY_COORDINATOR,
          env.SERVICE_NAME,
          (body, signature) => verifyLinearSignature(body, signature, env.LINEAR_WEBHOOK_SECRET),
        );
      }

      if (request.method === "POST" && url.pathname === "/complete") {
        return routeCompleteToCoordinator(
          request,
          env.DELIVERY_COORDINATOR,
          env.SERVICE_NAME,
          env.BRIDGE_SHARED_SECRET,
          id => env.LINEAR_DATA.get(`agent-session:${id}`),
        );
      }

      return new Response("Not found", { status: 404 });
    } catch (error) {
      console.error(error);
      return jsonResponse(
        { ok: false, error: error instanceof Error ? error.message : "Unexpected error" },
        500,
      );
    }
  },
};


// One Durable Object per Linear organization serializes webhook processing,
// OAuth refreshes from webhook traffic, and durable accepted/pending states.
// Alarms replay failed deliveries even after Linear stops retrying.
export class DeliveryCoordinator extends DurableObject<Env> {
  private tail: Promise<void> = Promise.resolve();

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(() => {}, () => {});
    return run;
  }

  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/complete") {
      return this.enqueue(() => handleAgentComplete(request, this.env));
    }
    return this.enqueue(() => coordinateWebhook(
      this.ctx.storage,
      request,
      retry => handleLinearWebhook(retry, this.env, (key, work) => onceDeliveryActivity(this.ctx.storage, key, work)),
    ));
  }

  alarm(): Promise<void> {
    return this.enqueue(() => retryPendingWebhooks(
      this.ctx.storage,
      retry => handleLinearWebhook(retry, this.env, (key, work) => onceDeliveryActivity(this.ctx.storage, key, work)),
    ));
  }
}

async function beginOAuth(env: Env): Promise<Response> {
  requireConfig(env, [
    "LINEAR_CLIENT_ID",
    "LINEAR_REDIRECT_URI",
    "LINEAR_SCOPES",
  ]);

  const state = crypto.randomUUID() + crypto.randomUUID();
  await env.LINEAR_DATA.put(`oauth-state:${state}`, "1", {
    expirationTtl: 600,
  });

  const authorize = new URL(LINEAR_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", env.LINEAR_REDIRECT_URI);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("actor", "app");
  authorize.searchParams.set("scope", env.LINEAR_SCOPES);

  return Response.redirect(authorize.toString(), 302);
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  requireConfig(env, [
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_REDIRECT_URI",
  ]);

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) {
    return htmlResponse(
      `<h1>Linear authorization failed</h1><p>${escapeHtml(error)}</p>`,
      400,
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return htmlResponse("<h1>Missing OAuth code or state.</h1>", 400);
  }

  const stateKey = `oauth-state:${state}`;
  const validState = await env.LINEAR_DATA.get(stateKey);
  if (!validState) {
    return htmlResponse("<h1>Invalid or expired OAuth state.</h1>", 400);
  }
  await env.LINEAR_DATA.delete(stateKey);

  const token = await exchangeCodeForToken(code, env);
  const identity = await linearGraphql<{
    viewer: {
      id: string;
      name?: string;
      organization: { id: string; name?: string };
    };
  }>(
    token.access_token,
    `query InstallationIdentity {
      viewer {
        id
        name
        organization {
          id
          name
        }
      }
    }`,
  );

  const organizationId = identity.viewer.organization.id;
  const installation: LinearInstallation = {
    organizationId,
    organizationName: identity.viewer.organization.name,
    appUserId: identity.viewer.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope,
    installedAt: new Date().toISOString(),
  };

  await env.LINEAR_DATA.put(
    `installation:${organizationId}`,
    JSON.stringify(installation),
  );

  return htmlResponse(`
    <main>
      <h1>${escapeHtml(env.SERVICE_NAME)} Agent installed</h1>
      <p>Linear workspace: <strong>${escapeHtml(
    installation.organizationName || organizationId,
  )}</strong></p>
      <p>The Worker can now receive Linear agent-session webhooks and forward them to your Mac bridge.</p>
      <p>You may close this window.</p>
    </main>
  `);
}

async function handleLinearWebhook(
  request: Request,
  env: Env,
  activityOnce: (key: string, perform: () => Promise<void>) => Promise<void> = async (_key, perform) => perform(),
): Promise<Response> {
  requireConfig(env, [
    "LINEAR_WEBHOOK_SECRET",
    "BRIDGE_URL",
    "BRIDGE_SHARED_SECRET",
  ]);

  const rawBody = await request.text();
  const providedSignature = request.headers.get("linear-signature") || "";
  const valid = await verifyLinearSignature(
    rawBody,
    providedSignature,
    env.LINEAR_WEBHOOK_SECRET,
  );

  if (!valid) {
    return jsonResponse({ ok: false, error: "Invalid Linear signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const organizationId = stringValue(payload.organizationId);
  if (!organizationId) {
    return jsonResponse(
      { ok: false, error: "Webhook payload has no organizationId" },
      400,
    );
  }

  // Use Linear's unique delivery ID for deduplication.
  // payload.webhookId identifies the webhook configuration itself and is reused
  // across different events, which can incorrectly suppress AgentSessionEvent.
  const webhookId =
    request.headers.get("linear-delivery") ||
    `event:${Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawBody)))).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;

  const linearEvent =
    request.headers.get("linear-event") ||
    stringValue(payload.type) ||
    "unknown";

  console.log("Linear webhook received", {
    webhookId,
    linearEvent,
    organizationId,
  });

  // Authentication must succeed before a delivery can be considered handled.
  // This KV marker only denotes a successful bridge acceptance, not an attempt.
  const dedupeKey = `webhook:${organizationId}:${webhookId}`;
  let installation: LinearInstallation | null;
  try {
    installation = await getInstallation(organizationId, env);
  } catch (error) {
    if (error instanceof ReauthorizationRequiredError) {
      console.error("Linear OAuth reauthorization required", { organizationId, service: env.SERVICE_NAME });
      return jsonResponse({ ok: false, accepted: false, error: "reauthorization_required", installUrl: new URL("/install", request.url).toString() }, 503);
    }
    throw error;
  }
  if (!installation) {
    return jsonResponse(
      { ok: false, error: "No OAuth installation found for this workspace" },
      409,
    );
  }

  if (await env.LINEAR_DATA.get(dedupeKey)) {
    return jsonResponse({ ok: true, duplicate: true });
  }

  // Issue status is authoritative for inbox deletion; session completion is not.
  if (linearEvent === "Issue" && (payload.action === "update" || payload.action === "updated")) {
    const issueId = stringValue(getNested(payload, "data", "id")) ||
      stringValue(getNested(payload, "issue", "id"));
    if (issueId) {
      try {
        const result = await linearGraphql<{issue:null | {id:string;state:null | {type:string}}}>(
          installation.accessToken,
          `query InboxCleanupIssue($id:String!){issue(id:$id){id state{type}}}`,
          {id:issueId},
        );
        if (result.issue?.state?.type === "completed") {
          const callback = new URL(env.BRIDGE_URL);
          callback.pathname = "/issue-completed";
          callback.search = "";
          const cleaned = await fetch(callback.toString(), {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.BRIDGE_SHARED_SECRET}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({issueId}),
          });
          if (!cleaned.ok) throw new Error(`Bridge cleanup HTTP ${cleaned.status}`);
          console.log("Completed Linear issue inbox cleanup submitted", {issueId});
        }
      } catch (error) {
        console.error("Completed issue cleanup failed", {issueId, error: String(error)});
        return jsonResponse({ok:false, error:"Issue cleanup failed; retry required"}, 503);
      }
    }
    await env.LINEAR_DATA.put(dedupeKey, "accepted", { expirationTtl: 86400 });
    return jsonResponse({ok:true, accepted:false, issueStatusProcessed:true});
  }

  const action = stringValue(payload.action);
  const isAgentFollowup = (request.headers.get("linear-event") || stringValue(payload.type)) === "AgentSessionEvent" &&
    action === "prompted";
  const followupBody = stringValue(getNested(payload, "agentActivity", "content", "body")) ||
    stringValue(getNested(payload, "data", "agentActivity", "content", "body"));
  // Follow-up events carry the new instruction in agentActivity rather than
  // promptContext. Dispatch only that instruction, not the whole issue again.
  const promptContext = isAgentFollowup ? followupBody : extractPromptContext(payload);
  const agentSessionId = extractAgentSessionId(payload);

  // Linear expects an Agent Activity within 10 seconds for a newly created
  // Agent Session. A normal HTTP 200/202 from the webhook or local bridge is
  // not enough to mark the agent as responsive.
  if (linearEvent === "AgentSessionEvent" && (action === "create" || action === "created")) {
    if (!agentSessionId) {
      console.error("AgentSessionEvent has no agent session ID", {
        webhookId,
        action,
      });

      return jsonResponse(
        {
          ok: false,
          error: "AgentSessionEvent has no agent session ID",
          webhookId,
        },
        422,
      );
    }

    try {
      await activityOnce(`started:${webhookId}:${agentSessionId}`, () => createAgentActivity(
        installation.accessToken,
        agentSessionId,
        {
          type: "thought",
          body: "I’ve received the task. Validating the bridge handoff before execution starts.",
        },
      ));

      console.log("Linear Agent Session acknowledged", {
        webhookId,
        agentSessionId,
      });
    } catch (error) {
      console.error("Unable to acknowledge Linear Agent Session", {
        webhookId,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      return jsonResponse(
        {
          ok: false,
          error: "Unable to acknowledge Linear Agent Session",
          webhookId,
          agentSessionId,
        },
        502,
      );
    }
  }

  // Inbox and permission notifications may not contain an agent prompt.
  // Acknowledge them without sending malformed jobs to the local daemon.
  if (!promptContext) {
    console.log("Webhook acknowledged without forwarding", {
      webhookId,
      linearEvent,
      reason: "No promptContext found",
    });

    return jsonResponse(
      {
        ok: true,
        accepted: false,
        ignored: true,
        reason: "No promptContext found",
        linearEvent,
      },
      200,
    );
  }

  if (agentSessionId) {
    await env.LINEAR_DATA.put(
      `agent-session:${agentSessionId}`,
      installation.organizationId,
      { expirationTtl: 60 * 60 * 24 * 14 },
    );
  }

  const completionUrl = new URL(request.url);
  completionUrl.pathname = "/complete";
  completionUrl.search = "";

  // Enrich the signed session with stable Linear IDs; do not infer paths from issue prose.
  let routing: { projectId: string; projectName: string; initiativeIds: string[]; agentLocation?: string | null } | undefined;
  const issueId = stringValue(getNested(payload, "agentSession", "issueId")) ||
    stringValue(getNested(payload, "agentSession", "issue", "id")) ||
    stringValue(getNested(payload, "data", "agentSession", "issueId")) ||
    stringValue(getNested(payload, "data", "agentSession", "issue", "id"));
  let routeFailure: "missing_issue" | "missing_project" | "missing_initiative" | "query_failed" | null = null;
  // Issue routing is required for every dispatched job, including webhook
  // variants that omit the agent session ID. Session ID controls only whether
  // an Agent Activity can be published, never whether routing is mandatory.
  if (!issueId) routeFailure = "missing_issue";
  if (issueId) {
      try {
        const result = await linearGraphql<{
          issue: { labels?: { nodes: LinearIssueLabel[] }; project: null | { id: string; name: string; initiatives: { nodes: Array<{ id: string; name: string }> } } };
        }>(installation.accessToken,
          `query BridgeIssueRouting($issueId: String!) {
            issue(id: $issueId) {
              project { id name initiatives { nodes { id name } } }
              labels { nodes { name parent { name } } }
            }
          }`, { issueId });
        if (result.issue?.project?.id) {
          const initiativeIds = await resolveProjectInitiativeIds(
            installation.accessToken,
            result.issue.project.id,
            result.issue.project.initiatives?.nodes?.map(item => item.id) || [],
          );
          // An empty, verified initiative list is valid for standalone projects.
          // Ubuntu's explicit routing registry decides whether it requires an
          // initiative or has a project.repository mapping.
          routing = {
            projectId: result.issue.project.id,
            projectName: result.issue.project.name,
            initiativeIds,
            agentLocation: issueAgentLocation(result.issue.labels?.nodes),
          };
        } else {
          routeFailure = "missing_project";
        }
      } catch (error) {
        routeFailure = "query_failed";
        console.error("Unable to enrich routing metadata", {
          agentSessionId,
          issueId,
          // Do not log raw GraphQL error bodies or upstream details.
          category: "query_failed",
        });
      }
  }

  // Never send a malformed job to the bridge and create a permanent
  // .unrouted.json claim. Report the pre-launch failure inside Linear instead.
  if (!routing?.projectId || routeFailure) {
    const category = routeFailure || "missing_project";
    console.error("Refusing job without verified Linear routing", {
      webhookId, issueId: issueId || null, agentSessionId: agentSessionId || null,
      linearEvent, action, category,
    });
    const messages: Record<string, string> = {
      missing_issue: "Antigravity could not identify the Linear issue for this session.",
      missing_project: "Antigravity could not verify the Linear project associated with this issue.",
      missing_initiative: "Antigravity could not verify initiative membership for the Linear project.",
      query_failed: "Antigravity could not retrieve complete routing metadata from Linear.",
    };
    if (agentSessionId) {
      try {
        const failureId = await stableActivityId(`routing-enrichment:${installation.organizationId}:${webhookId}:${agentSessionId}`);
        await activityOnce(`routing-enrichment:${webhookId}:${agentSessionId}`, () => createAgentActivity(
          installation.accessToken,
          agentSessionId,
          { type: "error", body: `${messages[category]} No job was dispatched. The delivery remains retryable.` },
          failureId,
        ));
      } catch {
        console.error("Unable to publish Linear routing failure", { webhookId, agentSessionId, category });
      }
    }
    return jsonResponse({ ok: false, accepted: false, error: "Routing metadata incomplete; retry required", category }, 503);
  }

  const bridgeJob = {
    routing,
    issueId,
    source: "linear",
    sessionAction: isAgentFollowup ? "prompted" : "created",
    receivedAt: new Date().toISOString(),
    organizationId: installation.organizationId,
    agentSessionId,
    completionUrl: completionUrl.toString(),
    payload: {
      data: {
        promptContext,
        agentSessionId,
        completionUrl: completionUrl.toString(),
      },
    },
  };

  // Wait for the bridge to durably accept the job before acknowledging Linear.
  // A failure returns a retryable HTTP response and does not poison deduplication.
  try {
    await forwardToMacBridge(bridgeJob, webhookId, linearEvent, env);
  } catch (error) {
    console.error("Failed to forward job to bridge", { webhookId, error: String(error) });
    if (agentSessionId) {
      const message = describePrelaunchFailure(error);
      try {
        const failureId = await stableActivityId(`handoff-failed:${installation.organizationId}:${webhookId}:${agentSessionId}`);
        await activityOnce(`handoff-failed:${webhookId}:${agentSessionId}`, () => createAgentActivity(
          installation.accessToken,
          agentSessionId,
          { type: "error", body: message },
          failureId,
        ));
      } catch (activityError) {
        // Keep the webhook retryable even if Linear activity publication fails.
        console.error("Unable to publish bridge handoff failure to Linear", {
          webhookId,
          agentSessionId,
          error: activityError instanceof Error ? activityError.message : String(activityError),
        });
      }
    }
    return jsonResponse({ ok: false, accepted: false, error: "Local bridge delivery failed; retry required" }, 503);
  }
  await env.LINEAR_DATA.put(dedupeKey, "accepted", { expirationTtl: 86400 });

  return jsonResponse(
    {
      ok: true,
      accepted: true,
      forwarded: true,
      webhookId,
      linearEvent,
    },
    200,
  );
}


async function handleAgentComplete(
  request: Request,
  env: Env,
): Promise<Response> {
  requireConfig(env, [
    "BRIDGE_SHARED_SECRET",
  ]);

  const authorization = request.headers.get("authorization") || "";
  if (authorization !== `Bearer ${env.BRIDGE_SHARED_SECRET}`) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const agentSessionId = stringValue(body.agentSessionId);
  const status = stringValue(body.status) || "completed";

  if (!agentSessionId) {
    return jsonResponse(
      { ok: false, error: "Missing agentSessionId" },
      400,
    );
  }

  const organizationId =
    stringValue(body.organizationId) ||
    (await env.LINEAR_DATA.get(`agent-session:${agentSessionId}`));

  if (!organizationId) {
    return jsonResponse(
      {
        ok: false,
        error: "No organization mapping found for agentSessionId",
        agentSessionId,
      },
      404,
    );
  }

  const installation = await getInstallation(organizationId, env);
  if (!installation) {
    return jsonResponse(
      {
        ok: false,
        error: "No OAuth installation found for this workspace",
        organizationId,
      },
      409,
    );
  }

  const requestedActivityType = stringValue(body.activityType);
  const supportedActivityTypes: AgentActivityContent["type"][] = [
    "thought", "response", "error", "elicitation",
  ];
  const activityType: AgentActivityContent["type"] =
    supportedActivityTypes.includes(requestedActivityType as AgentActivityContent["type"])
      ? requestedActivityType as AgentActivityContent["type"]
      : status === "failed" || status === "error" ? "error" : "response";

  const bodyText =
    stringValue(body.body) ||
    (activityType === "error" ? "Task failed." : "Task completed.");

  await createAgentActivity(
    installation.accessToken,
    agentSessionId,
    {
      type: activityType,
      body: bodyText,
    },
  );

  console.log("Linear Agent Session completion activity sent", {
    agentSessionId,
    organizationId,
    activityType,
  });

  return jsonResponse({
    ok: true,
    agentSessionId,
    organizationId,
    activityType,
  });
}

// Some Linear OAuth installations return an empty Project.initiatives
// connection even when the initiative/project association exists. Recover
// membership from the explicit association records; never infer IDs from
// route names, issue text, or local configuration.
async function resolveProjectInitiativeIds(
  accessToken: string,
  projectId: string,
  directIds: string[],
): Promise<string[]> {
  const ids = [...new Set(directIds.filter(id => /^[0-9a-f-]{36}$/i.test(id)))];
  if (ids.length) return ids;

  let after: string | null = null;
  const matches = new Set<string>();
  for (let page = 0; page < 20; page++) {
    const result: {
      initiativeToProjects: {
        nodes: Array<{ project: { id: string } | null; initiative: { id: string } | null }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await linearGraphql<{
      initiativeToProjects: {
        nodes: Array<{ project: { id: string } | null; initiative: { id: string } | null }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(accessToken,
      `query BridgeProjectInitiatives($after: String) {
        initiativeToProjects(first: 100, after: $after) {
          nodes { project { id } initiative { id } }
          pageInfo { hasNextPage endCursor }
        }
      }`, { after });
    const connection: typeof result.initiativeToProjects = result.initiativeToProjects;
    if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
      throw new Error("Linear initiative association response malformed");
    }
    for (const record of connection.nodes) {
      if (record?.project?.id === projectId &&
          typeof record.initiative?.id === "string") {
        matches.add(record.initiative.id);
      }
    }
    if (!connection.pageInfo.hasNextPage) return [...matches];
    const next: string | null = connection.pageInfo.endCursor;
    if (!next || next === after) throw new Error("Linear initiative association cursor invalid");
    after = next;
  }
  throw new Error("Linear initiative associations exceeded 20 pages; refusing incomplete routing");
}

async function forwardToMacBridge(
  bridgeJob: Record<string, unknown>,
  webhookId: string,
  linearEvent: string,
  env: Env,
): Promise<void> {
  console.log("Forwarding Linear job to bridge", {
    webhookId,
    linearEvent,
    bridgeUrl: env.BRIDGE_URL,
  });

  const response = await fetch(env.BRIDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.BRIDGE_SHARED_SECRET}`,
      "x-linear-webhook-id": webhookId,
    },
    body: JSON.stringify(bridgeJob),
    signal: AbortSignal.timeout(12000),
  });

  const responseBody = await response.text();

  console.log("Bridge response received", {
    webhookId,
    linearEvent,
    status: response.status,
    body: responseBody.slice(0, 500),
  });

  if (!response.ok) {
    let bridgeError = "";
    try {
      const parsed: unknown = JSON.parse(responseBody);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        const value = (parsed as { error?: unknown }).error;
        if (typeof value === "string") bridgeError = value;
      }
    } catch {
      // Bridge responses may be non-JSON. Never forward raw bodies to Linear.
    }
    throw new BridgeDeliveryError(response.status, bridgeError);
  }
}

class BridgeDeliveryError extends Error {
  readonly status: number;
  readonly bridgeError: string;

  constructor(status: number, bridgeError: string) {
    super(`Bridge rejected delivery (HTTP ${status})`);
    this.name = "BridgeDeliveryError";
    this.status = status;
    this.bridgeError = bridgeError;
  }
}

// Only publish recognized, redacted failure details. Arbitrary upstream errors
// can contain paths, credentials or tool output and must never go to Linear.
function describePrelaunchFailure(error: unknown): string {
  if (error instanceof BridgeDeliveryError) {
    const prefix = "Antigravity launch was rejected by the bridge. ";
    const unmapped = /^Unmapped Linear project: ([0-9a-f-]{36})$/i.exec(error.bridgeError.trim());
    if (unmapped) {
      return prefix + `The bridge has no routing entry for Linear project ${unmapped[1]}. The job is unrouted and requires operator reconciliation before work can start.`;
    }
    if (error.bridgeError.startsWith("Cannot load routing config ")) {
      return prefix + `The bridge could not load its routing configuration (HTTP ${error.status}). Check configuration and reconcile the pending job.`;
    }
    if (/^Expected one mapped initiative for project [0-9a-f-]{36}, found 0;/.test(error.bridgeError)) {
      return prefix + "The Worker could not supply a verified initiative membership. Check the association lookup and reconcile the unrouted job.";
    }
    return prefix + `Delivery rejected (HTTP ${error.status}). Check the local job ledger; failed/unrouted records may require manual reconciliation.`;
  }
  return "Antigravity handoff is not confirmed: the bridge request timed out or failed before acknowledgment. The job may have been accepted; inspect the ledger before replaying.";
}

// Linear accepts a caller-assigned UUIDv4 for agentActivityCreate. A stable
// ID prevents duplicate visible failures if a callback succeeds but the Worker
// loses its acknowledgment before persisting its local delivery marker.
async function stableActivityId(key: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string };

async function createAgentActivity(
  accessToken: string,
  agentSessionId: string,
  content: AgentActivityContent,
  activityId?: string,
): Promise<void> {
  const result = await linearGraphql<{
    agentActivityCreate: {
      success: boolean;
    };
  }>(
    accessToken,
    `mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
      }
    }`,
    {
      input: {
        agentSessionId,
        content,
        ...(activityId ? { id: activityId } : {}),
      },
    },
  );

  if (!result.agentActivityCreate.success) {
    throw new Error("Linear returned success=false for agentActivityCreate");
  }
}

function extractAgentSessionId(
  payload: Record<string, unknown>,
): string | undefined {
  const candidates: unknown[] = [
    getNested(payload, "data", "id"),
    getNested(payload, "agentSession", "id"),
    getNested(payload, "data", "agentSession", "id"),
    getNested(payload, "agentSessionId"),
    getNested(payload, "data", "agentSessionId"),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function extractPromptContext(payload: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    getNested(payload, "promptContext"),
    getNested(payload, "data", "promptContext"),
    getNested(payload, "data", "agentSession", "promptContext"),
    getNested(payload, "agentSession", "promptContext"),
    getNested(payload, "notification", "promptContext"),
    getNested(payload, "data", "notification", "promptContext"),
    getNested(payload, "data", "issue", "description"),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return undefined;
}

function getNested(
  value: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let current: unknown = value;

  for (const key of keys) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

async function exchangeCodeForToken(
  code: string,
  env: Env,
): Promise<LinearTokenResponse> {
  const body = new URLSearchParams({
    code,
    redirect_uri: env.LINEAR_REDIRECT_URI,
    client_id: env.LINEAR_CLIENT_ID,
    client_secret: env.LINEAR_CLIENT_SECRET,
    grant_type: "authorization_code",
  });

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Linear token exchange failed (${response.status}): ${text}`);
  }

  return JSON.parse(text) as LinearTokenResponse;
}

async function linearGraphql<T>(
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });

  const body = (await response.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };

  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(
      `Linear GraphQL request failed: ${JSON.stringify(body.errors || body)}`,
    );
  }

  return body.data;
}

async function verifyLinearSignature(
  body: string,
  suppliedHex: string,
  secret: string,
): Promise<boolean> {
  if (!suppliedHex || !/^[a-f0-9]+$/i.test(suppliedHex)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );

  const expectedHex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expectedHex.toLowerCase(), suppliedHex.toLowerCase());
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function requireConfig(env: Env, keys: Array<keyof Env>): void {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing Worker configuration: ${missing.join(", ")}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(
    `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <title>Linear Agent</title>
          <style>
            body { font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 64px auto; padding: 0 24px; }
            a { color: inherit; }
            code { background: #f3f3f3; padding: 2px 5px; border-radius: 4px; }
          </style>
        </head>
        <body>${body}</body>
      </html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

function homePage(origin: string, serviceName: string): string {
  return `
    <main>
      <h1>Linear → ${escapeHtml(serviceName)} Bridge</h1>
      <p>The Worker is running.</p>
      <p><a href="${escapeHtml(origin)}/install">Install the Linear app</a></p>
      <p>Health check: <code>${escapeHtml(origin)}/health</code></p>
      <p>Linear webhook: <code>${escapeHtml(origin)}/webhook</code></p>
      <p>Completion webhook: <code>${escapeHtml(origin)}/complete</code></p>
      <p>OAuth callback: <code>${escapeHtml(origin)}/oauth/callback</code></p>
    </main>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] || character,
  );
}
