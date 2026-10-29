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

const inFlight = new Map<string, Promise<unknown>>();
/** Singleflight protects refresh-token rotation within one Worker isolate.
 * A Durable Object is still required for cross-isolate coordination. */
export function withRefreshSingleflight<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const running = work();
  inFlight.set(key, running);
  void running.finally(() => {
    if (inFlight.get(key) === running) inFlight.delete(key);
  }).catch(() => {});
  return running;
}
