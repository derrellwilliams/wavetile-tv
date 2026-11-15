/// The signed-in session, kept in app-private storage so the TV stays signed in between launches.
/// The token lives here and in request headers only: never log this object.
import { signal } from "@preact/signals";
import { SERVER_ID, type Session } from "./auth";
import { load, save } from "./storage";

const KEY = "session";
const FIELDS = ["server", "serverName", "serverVersion", "userId", "userName", "token"] as const;

function read(): Session | null {
  const raw = load(KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || !FIELDS.every((field) => typeof value[field] === "string" && value[field] !== "")) return null;
    if (!/^https?:\/\//.test(value.server as string)) return null;
    const saved = Object.fromEntries(FIELDS.map((field) => [field, value[field]])) as unknown as Session;
    // Older sessions have no server Id; `refresh` adds it at the next launch.
    if (typeof value.serverId === "string" && SERVER_ID.test(value.serverId)) saved.serverId = value.serverId;
    return saved;
  } catch {
    return null;
  }
}

export const session = signal<Session | null>(read());

export function setSession(next: Session | null): void {
  session.value = next;
  save(KEY, next ? JSON.stringify(next) : null);
}
