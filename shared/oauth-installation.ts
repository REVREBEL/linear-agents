import { isInvalidGrant, ReauthorizationRequiredError, withRefreshSingleflight } from "./oauth-errors";

export interface LinearInstallation {
  organizationId: string;
  organizationName?: string;
  appUserId?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string | string[];
  installedAt: string;
}
interface LinearTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string | string[];
  refresh_token?: string;
}
export interface InstallationEnv {
  LINEAR_DATA: KVNamespace;
  LINEAR_CLIENT_ID: string;
  LINEAR_CLIENT_SECRET: string;
  SERVICE_NAME: string;
}

export async function getInstallation(
  organizationId: string,
  env: InstallationEnv,
): Promise<LinearInstallation | null> {
  return withRefreshSingleflight(`${env.SERVICE_NAME}:${organizationId}`, async () => {
    const raw = await env.LINEAR_DATA.get(`installation:${organizationId}`);
    if (!raw) return null;
    const installation = JSON.parse(raw) as LinearInstallation;
    if (installation.expiresAt > Date.now() + 60_000) return installation;
    if (!installation.refreshToken) throw new ReauthorizationRequiredError();

    const refreshed = await refreshLinearToken(installation.refreshToken, env);
    const updated: LinearInstallation = {
      ...installation,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || installation.refreshToken,
      expiresAt: Date.now() + refreshed.expires_in * 1000,
      scope: refreshed.scope,
    };
    await env.LINEAR_DATA.put(`installation:${organizationId}`, JSON.stringify(updated));
    return updated;
  });
}

async function refreshLinearToken(
  refreshToken: string,
  env: InstallationEnv,
): Promise<LinearTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    grant_type: "refresh_token",
    client_id: env.LINEAR_CLIENT_ID,
    client_secret: env.LINEAR_CLIENT_SECRET,
  });
  const response = await fetch("https://api.linear.app/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    if (isInvalidGrant(response.status, responseText)) throw new ReauthorizationRequiredError();
    throw new Error(`Linear token refresh failed (HTTP ${response.status})`);
  }
  return JSON.parse(responseText) as LinearTokenResponse;
}
