/// The one place the app talks to a Jellyfin server. Thin on purpose: JSON in, JSON out, a time
/// limit, and errors that never carry the token, a query string or a request body.

const CLIENT = "Wavetile TV";
const DEVICE = "LG TV";
export const APP_VERSION = "0.1.0";

export interface Connection {
  server: string; // base URL, no trailing slash
  token?: string;
  deviceId: string;
  /// The server Id saved at sign-in. When set, a request that carries the token first checks that
  /// the address still answers as that server (see `confirmServer`).
  serverId?: string;
}

/// `status` is the HTTP status, or 0 when the server couldn't be reached (offline, timeout, CORS).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(status ? `${what}: HTTP ${status}` : `${what}: server not reachable`);
  }
}

/// Jellyfin's Authorization header. Values are fixed strings or hex, so nothing needs escaping.
export function authHeader(deviceId: string, token?: string): string {
  const parts = [`Client="${CLIENT}"`, `Device="${DEVICE}"`, `DeviceId="${deviceId}"`, `Version="${APP_VERSION}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

interface Options {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  /// Return the reply as text instead of parsing it as JSON (subtitle files).
  as?: "text";
}

const MAX_TEXT_REPLY = 5_000_000;
/// Library replies are paged, so even a big page is well under this.
const MAX_JSON_REPLY = 20_000_000;

/// Reads a reply's body but stops as soon as it passes `max` bytes, so a broken or hostile server
/// can't make the app hold an endless reply in memory. Throws RangeError when the reply is too big.
export async function readCapped(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get("Content-Length"));
  if (declared > max) {
    response.body?.cancel().catch(() => undefined);
    throw new RangeError("reply too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      reader.cancel().catch(() => undefined);
      throw new RangeError("reply too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/// How long a confirmed server stays confirmed. A network change (online/offline) or a failed
/// request ends it sooner.
const CONFIRM_MS = 60_000;
let confirmed: { server: string; id: string; until: number } | null = null;
let confirming: { server: string; id: string; done: Promise<boolean> } | null = null;

/// Forget the confirmed server, so the next request with the token checks again.
export function forgetConfirmedServer(): void {
  confirmed = null;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", forgetConfirmedServer);
  window.addEventListener("offline", forgetConfirmedServer);
}

/// True when `server` answers its public info (no token sent) with the Id saved at sign-in. Stops
/// the token going to whatever holds the same LAN address on another network (a hotel or café).
export async function confirmServer(server: string, id: string, deviceId: string): Promise<boolean> {
  if (confirmed && confirmed.server === server && confirmed.id === id && Date.now() < confirmed.until) return true;
  if (confirming && confirming.server === server && confirming.id === id) return confirming.done;
  const done = (async () => {
    try {
      const info = await request<{ Id?: unknown } | null>({ server, deviceId }, "/System/Info/Public", { timeoutMs: 6000 });
      const ok = typeof info?.Id === "string" && info.Id.toLowerCase() === id.toLowerCase();
      confirmed = ok ? { server, id, until: Date.now() + CONFIRM_MS } : null;
      return ok;
    } catch {
      confirmed = null;
      return false;
    }
  })();
  confirming = { server, id, done };
  try {
    return await done;
  } finally {
    if (confirming?.done === done) confirming = null;
  }
}

export async function request<T>(connection: Connection, path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? "GET";
  const what = `${method} ${path}`; // safe to show or log: no host, query or body
  if (connection.token && connection.serverId && !(await confirmServer(connection.server, connection.serverId, connection.deviceId))) {
    throw new ApiError(0, what);
  }
  const query = options.query ? `?${new URLSearchParams(options.query)}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);

  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authHeader(connection.deviceId, connection.token),
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(connection.server + path + query, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        credentials: "omit",
        redirect: "error", // a redirect could carry the token to another host
      });
    } catch {
      forgetConfirmedServer(); // unreachable: maybe a new network, so check again next time
      throw new ApiError(0, what);
    }
    if (!response.ok) throw new ApiError(response.status, what);
    if (response.status === 204) return undefined as T;

    // The time limit above still runs while the body arrives, so a slow trickle is cut off too.
    const bytes = await readCapped(response, options.as === "text" ? MAX_TEXT_REPLY : MAX_JSON_REPLY).catch(() => {
      throw new ApiError(0, what);
    });
    const text = new TextDecoder().decode(bytes); // UTF-8, BOM dropped, as response.text() does
    if (options.as === "text") return text as T;
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Something answered, but not a Jellyfin server (a router page, a captive portal).
      throw new ApiError(0, what);
    }
  } finally {
    clearTimeout(timer);
  }
}
