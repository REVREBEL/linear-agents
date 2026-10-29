// Shared OAuth failure classification for all Linear Workers.
// Never include token endpoint response bodies in client-facing errors.
export class ReauthorizationRequiredError extends Error {
  constructor() {
    super("Linear app authorization expired; reinstall the app using /install");
    this.name = "ReauthorizationRequiredError";
  }
}
export function isInvalidGrant(status: number, body: string): boolean {
  if (status !== 400 && status !== 401) return false;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    return parsed.error === "invalid_grant";
  } catch {
    return /(?:^|[^a-z])invalid_grant(?:[^a-z]|$)/.test(body);
  }
}
