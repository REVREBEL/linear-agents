interface Env {
  LINEAR_DATA: KVNamespace;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  LINEAR_WEBHOOK_SECRET: string;
  LINEAR_REDIRECT_URI: string;
  LINEAR_SCOPES: string;
  BRIDGE_URL: string;
  BRIDGE_SHARED_SECRET: string;
  SERVICE_NAME: string;
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

      if (request.method === "GET" && url.pathname === "/") {
        return htmlResponse(homePage(url.origin, env.SERVICE_NAME));
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          service: env.SERVICE_NAME || "linear-agent-worker",
        });
      }

      if (request.method === "GET" && url.pathname === "/install") {
        return beginOAuth(env);
      }

      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        return handleOAuthCallback(request, env);
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        return handleLinearWebhook(request, env, ctx);
      }

      if (request.method === "POST" && url.pathname === "/mock-action") {
        return handleMockAction(request, env);
      }

      if (request.method === "POST" && url.pathname === "/complete") {
        return handleAgentComplete(request, env);
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
  ctx: ExecutionContext,
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
    stringValue(payload.webhookId) ||
    crypto.randomUUID();

  const linearEvent =
    request.headers.get("linear-event") ||
    stringValue(payload.type) ||
    "unknown";

  console.log("Linear webhook received", {
    webhookId,
    linearEvent,
    organizationId,
  });

  const dedupeKey = `webhook:${webhookId}`;
  if (await env.LINEAR_DATA.get(dedupeKey)) {
    return jsonResponse({ ok: true, duplicate: true });
  }
  await env.LINEAR_DATA.put(dedupeKey, "1", { expirationTtl: 86400 });

  const installation = await getInstallation(organizationId, env);
  if (!installation) {
    return jsonResponse(
      { ok: false, error: "No OAuth installation found for this workspace" },
      409,
    );
  }

  // Issue workflow completion, not agent session completion, clears local inbox.
  // Query Linear's current state rather than trusting webhook body labels.
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
      }
    }
    return jsonResponse({ok:true, accepted:false, issueStatusProcessed:true});
  }

  const action = stringValue(payload.action);
  const isAgentFollowup = linearEvent === "AgentSessionEvent" && action === "prompted";
  const followupBody = stringValue(getNested(payload, "agentActivity", "content", "body")) ||
    stringValue(getNested(payload, "data", "agentActivity", "content", "body"));
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
      await createAgentActivity(
        installation.accessToken,
        agentSessionId,
        {
          type: "thought",
          body: "I’ve received the task and started working on it.",
        },
      );

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

  // Fetch authoritative issue metadata for the routed job. PR and review
  // evidence must be read from GitHub/Linear when they actually exist.
  let routing: { projectId: string; projectName: string; initiativeIds: string[] } | undefined;
  let issueMetadata: { id: string; identifier: string; status: string | null; projectId: string | null } | undefined;
  if (agentSessionId) {
    const issueId = stringValue(getNested(payload, "agentSession", "issueId")) ||
      stringValue(getNested(payload, "agentSession", "issue", "id"));
    if (issueId) {
      try {
        const result = await linearGraphql<{
          issue: { id: string; identifier: string; state: null | { name: string }; project: null | { id: string; name: string; initiatives: { nodes: Array<{ id: string; name: string }> } } };
        }>(installation.accessToken,
          `query BridgeIssueRouting($issueId: String!) {
            issue(id: $issueId) {
              id identifier state { name }
              project { id name initiatives { nodes { id name } } }
            }
          }`, { issueId });
        if (result.issue) {
          issueMetadata = {
            id: result.issue.id,
            identifier: result.issue.identifier,
            status: result.issue.state?.name || null,
            projectId: result.issue.project?.id || null,
          };
          if (result.issue.project) {
            routing = {
              projectId: result.issue.project.id,
              projectName: result.issue.project.name,
              initiativeIds: result.issue.project.initiatives?.nodes?.map(item => item.id) || [],
            };
          }
        }
      } catch (error) {
        console.error("Unable to enrich routing metadata", {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const bridgeJob = {
    routing,
    issueId: stringValue(getNested(payload, "agentSession", "issueId")) ||
      stringValue(getNested(payload, "agentSession", "issue", "id")) ||
      stringValue(getNested(payload, "data", "agentSession", "issueId")) ||
      stringValue(getNested(payload, "data", "agentSession", "issue", "id")),
    issueMetadata,
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

  ctx.waitUntil(
    forwardToMacBridge(
      bridgeJob,
      webhookId,
      linearEvent,
      env,
    ).catch(async (error) => {
      console.error("Failed to forward job to Mac bridge", {
        webhookId,
        linearEvent,
        error: error instanceof Error ? error.message : String(error),
      });
      if (agentSessionId) {
        try {
          await createAgentActivity(installation.accessToken, agentSessionId, {
            type: "error",
            body: "Unable to deliver this task to a verified local workspace. Check the local bridge routing configuration and Worker logs.",
          });
        } catch (activityError) {
          console.error("Failed to report local dispatch error to Linear", {
            agentSessionId,
            error: activityError instanceof Error ? activityError.message : String(activityError),
          });
        }
      }
    }),
  );

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


// Operator-only Mock Agent actions. Authentication is shared with the
// trusted bridge, while Linear writes use this app installation's OAuth token.
async function handleMockAction(request: Request, env: Env): Promise<Response> {
  if (!env.BRIDGE_SHARED_SECRET ||
      request.headers.get("authorization") !== `Bearer ${env.BRIDGE_SHARED_SECRET}`) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }
  const body = await request.json() as Record<string, unknown>;
  const issue = stringValue(body.issue);
  const operation = stringValue(body.operation);
  if (!issue || !["inspect", "submit"].includes(operation || "")) {
    return jsonResponse({ ok: false, error: "Invalid issue or operation" }, 400);
  }
  const organizationId = stringValue(body.organizationId);
  if (!organizationId) return jsonResponse({ ok: false, error: "organizationId required" }, 400);
  const installation = await getInstallation(organizationId, env);
  if (!installation) return jsonResponse({ ok: false, error: "No Mock app installation for workspace" }, 404);
  const result = await linearGraphql<{
    issue: null | { id: string; identifier: string; title: string; state: { id: string; name: string }; team: { states: { nodes: Array<{id: string; name: string; type: string}> } } };
  }>(installation.accessToken,
    `query MockAgentIssue($id:String!){issue(id:$id){id identifier title state{id name} team{states{nodes{id name type}}}}}`,
    { id: issue });
  if (!result.issue) return jsonResponse({ ok: false, error: "Issue not found" }, 404);
  const item = result.issue;
  const statuses = item.team.states.nodes.map(x => ({ id:x.id,name:x.name,type:x.type }));
  if (operation === "inspect") {
    return jsonResponse({ ok: true, issue: { id:item.id, identifier:item.identifier, title:item.title, status:item.state.name }, statuses });
  }
  const comment = stringValue(body.comment);
  const statusId = stringValue(body.statusId);
  if (!comment && !statusId) return jsonResponse({ok:false,error:"Comment or status required"},400);
  if (comment && comment.length > 15000) return jsonResponse({ok:false,error:"Comment too long"},400);
  if (statusId && !statuses.some(x=>x.id===statusId)) return jsonResponse({ok:false,error:"Invalid status for issue team"},400);
  // Submit comment first and status second. Return partial success if the
  // second write fails; do not silently retry and duplicate the comment.
  let commentPosted = false;
  if (comment) {
    const result = await linearGraphql<{commentCreate:{success:boolean}}>(installation.accessToken,
      `mutation MockComment($input:CommentCreateInput!){commentCreate(input:$input){success}}`,
      {input:{issueId:item.id,body:comment}});
    if (!result.commentCreate.success) return jsonResponse({ok:false,error:"Comment rejected"},502);
    commentPosted = true;
  }
  if (statusId) {
    try {
      const result = await linearGraphql<{issueUpdate:{success:boolean}}>(installation.accessToken,
        `mutation MockStatus($id:String!,$stateId:String!){issueUpdate(id:$id,input:{stateId:$stateId}){success}}`,
        {id:item.id,stateId:statusId});
      if (!result.issueUpdate.success) throw new Error("Status rejected");
    } catch (error) {
      return jsonResponse({ok:false,commentPosted,statusChanged:false,error:error instanceof Error?error.message:String(error)},502);
    }
  }
  return jsonResponse({ok:true,commentPosted,statusChanged:Boolean(statusId),issue:item.identifier});
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

  const activityType: AgentActivityContent["type"] =
    status === "failed" || status === "error" ? "error" : "response";

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
  });

  const responseBody = await response.text();

  console.log("Bridge response received", {
    webhookId,
    linearEvent,
    status: response.status,
    body: responseBody.slice(0, 500),
  });

  if (!response.ok) {
    throw new Error(
      `Mac bridge returned ${response.status}: ${responseBody.slice(0, 500)}`,
    );
  }
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

async function getInstallation(
  organizationId: string,
  env: Env,
): Promise<LinearInstallation | null> {
  const raw = await env.LINEAR_DATA.get(`installation:${organizationId}`);
  if (!raw) return null;

  const installation = JSON.parse(raw) as LinearInstallation;

  if (
    installation.expiresAt > Date.now() + 60_000 ||
    !installation.refreshToken
  ) {
    return installation;
  }

  const refreshed = await refreshLinearToken(installation.refreshToken, env);
  const updated: LinearInstallation = {
    ...installation,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token || installation.refreshToken,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    scope: refreshed.scope,
  };

  await env.LINEAR_DATA.put(
    `installation:${organizationId}`,
    JSON.stringify(updated),
  );

  return updated;
}

async function refreshLinearToken(
  refreshToken: string,
  env: Env,
): Promise<LinearTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    client_id: env.LINEAR_CLIENT_ID,
    client_secret: env.LINEAR_CLIENT_SECRET,
  });

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Linear token refresh failed (${response.status}): ${text}`);
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
