// Durable per-organization webhook acceptance and replay state.
// This helper is shared by all five Workers; the hosting Worker owns the
// Durable Object class, its env, and the verified webhook dispatcher.
type StoredRequest = {
  url: string;
  body: string;
  headers: Record<string, string>;
  attempts: number;
  nextAttemptAt: number;
};
type StorageLike = DurableObjectStorage;

const PREFIX = "pending:";
const ACCEPTED = "accepted:";
const RETRY_MAX_MS = 2 * 60 * 60 * 1000;

async function deliveryKey(request: Request): Promise<string> {
  const id = request.headers.get("linear-delivery");
  if (id) return id;
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(await request.clone().text()));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

function serializedRequest(request: Request, body: string, attempts: number): StoredRequest {
  const headers: Record<string, string> = {};
  for (const name of ["linear-signature", "linear-delivery", "linear-event", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  return { url: request.url, body, headers, attempts, nextAttemptAt: Date.now() };
}
function rehydrate(item: StoredRequest): Request {
  return new Request(item.url, { method: "POST", headers: item.headers, body: item.body });
}

async function scheduleNext(storage: StorageLike): Promise<void> {
  const pending = await storage.list<StoredRequest>({ prefix: PREFIX });
  if (!pending.size) return;
  const next = Math.min(...Array.from(pending.values(), entry => entry.nextAttemptAt));
  const existing = await storage.getAlarm();
  if (existing === null || existing > next) await storage.setAlarm(Math.max(Date.now() + 1000, next));
}

async function attempt(
  storage: StorageLike,
  key: string,
  item: StoredRequest,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  try {
    const response = await dispatch(rehydrate(item));
    if (response.ok) {
      // Successful bridge acceptance is committed atomically in this DO.
      await storage.put(ACCEPTED + key, Date.now());
      await storage.delete(PREFIX + key);
      return response;
    }
    await postpone(storage, key, item);
    return response;
  } catch (error) {
    console.error("Durable delivery attempt failed", { key, error: String(error) });
    await postpone(storage, key, item);
    return Response.json({ ok: false, accepted: false, error: "delivery_retry_scheduled" }, { status: 503 });
  }
}
async function postpone(storage: StorageLike, key: string, item: StoredRequest): Promise<void> {
  const attempts = item.attempts + 1;
  const delay = Math.min(RETRY_MAX_MS, 60_000 * 2 ** Math.min(attempts - 1, 7));
  await storage.put(PREFIX + key, { ...item, attempts, nextAttemptAt: Date.now() + delay });
  await scheduleNext(storage);
}

export async function coordinateWebhook(
  storage: StorageLike,
  request: Request,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  const key = await deliveryKey(request);
  if (await storage.get(ACCEPTED + key)) return Response.json({ ok: true, duplicate: true });
  const old = await storage.get<StoredRequest>(PREFIX + key);
  const item = old || serializedRequest(request, await request.clone().text(), 0);
  if (!old) {
    // Persist the signed payload *before* any external OAuth or bridge operation.
    await storage.put(PREFIX + key, item);
  }
  return attempt(storage, key, item, dispatch);
}

export async function retryPendingWebhooks(
  storage: StorageLike,
  dispatch: (request: Request) => Promise<Response>,
): Promise<void> {
  const items = await storage.list<StoredRequest>({ prefix: PREFIX, limit: 30 });
  const now = Date.now();
  for (const [fullKey, item] of items) {
    if (item.nextAttemptAt <= now) await attempt(storage, fullKey.slice(PREFIX.length), item, dispatch);
  }
  await scheduleNext(storage);
}

/** Verify before resolving a DO to prevent unauthorized callers from
 * manufacturing per-organization coordinator instances. */
export async function routeWebhookToCoordinator(
  request: Request,
  namespace: DurableObjectNamespace,
  serviceName: string,
  verifySignature: (body: string, signature: string) => Promise<boolean>,
): Promise<Response> {
  const raw = await request.clone().text();
  if (!await verifySignature(raw, request.headers.get("linear-signature") || "")) {
    return Response.json({ ok: false, error: "Invalid Linear signature" }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const org = payload.organizationId;
  if (typeof org !== "string" || !org || org.length > 256) {
    return Response.json({ ok: false, error: "Invalid organizationId" }, { status: 400 });
  }
  const id = namespace.idFromName(`${serviceName}:${org}`);
  return namespace.get(id).fetch(request);
}
