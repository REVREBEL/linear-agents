import { getInstallation, type InstallationEnv } from "./oauth-installation";

export async function serveBridgeAccessToken(
  request: Request,
  env: InstallationEnv & { BRIDGE_SHARED_SECRET: string },
): Promise<Response> {
  if (!env.BRIDGE_SHARED_SECRET || request.headers.get("authorization") !== `Bearer ${env.BRIDGE_SHARED_SECRET}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try { body = await request.json(); }
  catch { return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }
  const id = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).organizationId : null;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) {
    return Response.json({ ok: false, error: "Invalid organizationId" }, { status: 400 });
  }
  const installation = await getInstallation(id, env);
  if (!installation) return Response.json({ ok: false, error: "Installation not found" }, { status: 404 });
  return Response.json(
    { ok: true, accessToken: installation.accessToken, expiresAt: installation.expiresAt },
    { headers: { "Cache-Control": "no-store", "Pragma": "no-cache" } },
  );
}
