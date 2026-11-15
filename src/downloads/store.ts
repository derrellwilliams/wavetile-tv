/// Films saved on the tablet: the list (kept in app storage), the runner that hands transfers to
/// Android one at a time and watches them, and the progress made offline that waits for the
/// server. Android only; on the TV nothing calls into here (the Downloads tab and buttons are
/// behind `isAndroid`), and the native bridge is reached through `loadNative()`.
import { signal } from "@preact/signals";
import { connectionOf, type Session } from "../api/auth";
import { authHeader, confirmServer, readCapped, request } from "../api/client";
import { artSrc, type Item } from "../api/items";
import { allEpisodes } from "../api/library";
import { session as current } from "../api/session";
import { deviceId, load, save } from "../api/storage";
import { deleteCache, readCache, writeCache } from "../data/cache";
import { loadNative } from "../platform/native-load";
import { plan as askServer, subtitleCues, toTicks } from "../player/playback";
import { deleteWatchedOn } from "../player/settings";
import type { Cue } from "../subtitles/cues";
import { CONVERT, estimateBytes, fileName, fits, isFinished, nextToStart, queueProgress, toSave, type Pending, type Saved } from "./plan";

export const saved = signal<Saved[]>(read<Saved>("downloads"));
export const pending = signal<Pending[]>(read<Pending>("downloads.pending"));
/// Free and total bytes on the tablet, refreshed while the Downloads tab is open.
export const space = signal<{ free: number; total: number } | null>(null);

function read<T>(key: string): T[] {
  try {
    const value = JSON.parse(load(key) ?? "[]") as unknown;
    return Array.isArray(value) ? (value as T[]).slice(0, 500) : [];
  } catch {
    return [];
  }
}

function put(next: Saved[]): void {
  saved.value = next;
  save("downloads", JSON.stringify(next));
}

function change(id: string, patch: Partial<Saved>): void {
  put(saved.value.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
}

export const find = (id: string): Saved | undefined => saved.value.find((entry) => entry.id === id);

/// A copy that can be played from the tablet now.
export const playable = (id: string): Saved | undefined => {
  const entry = find(id);
  return entry?.state === "done" && entry.path ? entry : undefined;
};

const cuesKey = (id: string, index: number) => `dl:cues:${id}:${index}`;
const artKey = (id: string) => `dl:art:${id}`;

/// The poster kept on the tablet for a saved film, so the Downloads tab has art with no server.
export const savedArt = (id: string) => readCache<Blob>(artKey(id));

const MAX_ART = 2_000_000;

/// Fetches the poster once and keeps the picture itself (images need no token). Quiet on failure:
/// the row then falls back to the server's address while it is reachable.
export async function keepArt(item: Item): Promise<void> {
  if (await savedArt(item.id)) return;
  const src = artSrc(item.poster ?? item.thumb, 120, 180);
  if (!src) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const reply = await fetch(src, { signal: controller.signal, credentials: "omit", redirect: "error" });
    const type = (reply.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!reply.ok || !type.startsWith("image/")) return;
    const bytes = await readCapped(reply, MAX_ART);
    if (bytes.byteLength > 0) await writeCache(artKey(item.id), new Blob([bytes], { type }));
  } catch {
    // No picture offline for this one (too big, too slow, or the server is away).
  } finally {
    clearTimeout(timer);
  }
}
export const savedCues = (id: string, index: number) => readCache<Cue[]>(cuesKey(id, index));

/// The next saved episode of the same show, for Up Next while offline.
export function nextSaved(episode: Item): Saved | undefined {
  if (!episode.seriesId) return undefined;
  const order = (item: Item) => (item.season ?? 0) * 100000 + (item.episode ?? 0);
  return saved.value
    .filter((entry) => entry.state === "done" && entry.item.seriesId === episode.seriesId && order(entry.item) > order(episode))
    .sort((a, b) => order(a.item) - order(b.item))[0];
}

/// What the user is told when Android gives up on a transfer.
export function failureNote(reason: number): string {
  if (reason === 401 || reason === 403) return "The server doesn't let this user download. Turn on Allow media downloads for them in Jellyfin.";
  if (reason === 404) return "The server doesn't have this file any more.";
  if (reason === 1006) return "The tablet is out of space.";
  if (reason === 1009) return "It was already saved.";
  if (reason >= 500 && reason < 600) return "The server had a problem making the file. Try again later.";
  return "The transfer stopped. Check the Wi-Fi and try again.";
}

function downloadUrl(user: Session, itemId: string, kind: Saved["kind"], sourceId: string): string {
  if (kind === "original") return `${user.server}/Items/${itemId}/Download?${new URLSearchParams({ mediaSourceId: sourceId })}`;
  const query = new URLSearchParams({
    mediaSourceId: sourceId,
    deviceId: deviceId(),
    videoCodec: "h264",
    audioCodec: "aac",
    videoBitRate: String(CONVERT.videoBitrate),
    audioBitRate: String(CONVERT.audioBitrate),
    maxAudioChannels: "2",
    maxWidth: String(CONVERT.width),
    subtitleMethod: "Drop",
  });
  return `${user.server}/Videos/${itemId}/stream.mp4?${query}`;
}

/// Adds a film or episode to the queue. Asks the server how the tablet would play it: the original
/// file if it can, else a conversion. Throws a message for the user when it can't be queued.
export async function enqueue(item: Item): Promise<void> {
  const user = current.value;
  if (!user) throw new Error("Sign in first.");
  if (find(item.id)) return;
  const made = await askServer(user, item.id, { startSeconds: 0 }).catch(() => {
    throw new Error("The server didn't answer. Try again when it is reachable.");
  });
  const kind = made.method === "DirectPlay" ? "original" : "converted";
  const source = made.source;
  const native = await loadNative();
  const info = await native?.Downloads.info();
  const estimate = estimateBytes(kind, source.size, source.seconds, CONVERT.videoBitrate + CONVERT.audioBitrate);
  if (info) {
    space.value = { free: info.freeBytes, total: info.totalBytes };
    if (!fits(estimate, info.freeBytes, saved.value)) throw new Error("There isn't room on the tablet for this.");
  }
  const text = source.subs.filter((track) => track.text);
  put([
    ...saved.value,
    {
      id: item.id,
      item,
      kind,
      state: "queued",
      file: fileName(item.id, kind, source.container?.split(",")[0]),
      bytes: 0,
      total: 0,
      estimate,
      sourceId: source.id,
      subs: text,
      addedAt: Date.now(),
    },
  ]);
  // The subtitle cues are kept now, while the server is reachable, so they work offline later.
  for (const track of text) {
    try {
      await writeCache(cuesKey(item.id, track.index), await subtitleCues(user, item.id, source.id, track.index));
    } catch {
      // That track just won't be there offline.
    }
  }
  void keepArt(item);
  void tick();
}

/// Queues every episode of a list that isn't saved yet. Returns how many were added.
export async function enqueueMany(items: readonly Item[]): Promise<number> {
  const have = new Set(saved.value.map((entry) => entry.id));
  let added = 0;
  for (const item of toSave(items, have, false)) {
    try {
      await enqueue(item);
      added++;
    } catch (failure) {
      if (!added) throw failure;
      break;
    }
  }
  return added;
}

export async function enqueueUnwatched(seriesId: string): Promise<number> {
  const user = current.value;
  if (!user) throw new Error("Sign in first.");
  const episodes = await allEpisodes(user, seriesId).catch(() => {
    throw new Error("The server didn't answer. Try again when it is reachable.");
  });
  return enqueueMany(episodes.filter((episode) => !episode.played));
}

/// Cancels a transfer or deletes a saved film (the file goes with it).
export async function discard(id: string): Promise<void> {
  const entry = find(id);
  if (!entry) return;
  put(saved.value.filter((other) => other.id !== id));
  for (const track of entry.subs) void deleteCache(cuesKey(id, track.index));
  void deleteCache(artKey(id));
  if (entry.transfer !== undefined) {
    const native = await loadNative();
    await native?.Downloads.remove({ id: entry.transfer }).catch(() => undefined);
  }
  void tick();
}

/// Tries a failed or stopped transfer again.
export function retry(id: string): void {
  const entry = find(id);
  if (entry && entry.state === "failed") {
    change(id, { state: "queued", transfer: undefined, bytes: 0, total: 0, note: undefined });
    void tick();
  }
}

let ticking = false;

/// One look at the transfers: update the running one, start the next queued one.
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const user = current.value;
    const native = await loadNative();
    if (!native || !user) return;
    for (const entry of saved.value) {
      if (entry.state !== "running" || entry.transfer === undefined) continue;
      const status = await native.Downloads.status({ id: entry.transfer }).catch(() => null);
      if (!status) continue;
      if (status.state === "successful") {
        const info = await native.Downloads.info();
        change(entry.id, { state: "done", bytes: status.bytes, total: status.bytes, path: `${info.directory}/${entry.file}` });
      } else if (status.state === "failed") {
        change(entry.id, { state: "failed", note: failureNote(status.reason) });
      } else if (status.state === "unknown") {
        // Android forgot it (cleared from outside): queue it again.
        change(entry.id, { state: "queued", transfer: undefined, bytes: 0 });
      } else {
        change(entry.id, { bytes: status.bytes, total: status.total > 0 ? status.total : entry.total, state: "running" });
      }
    }
    const next = nextToStart(saved.value);
    // The transfer carries the token, so only start it when the saved server is the one answering.
    if (next && (!user.serverId || (await confirmServer(user.server, user.serverId, deviceId())))) {
      const info = await native.Downloads.info();
      space.value = { free: info.freeBytes, total: info.totalBytes };
      try {
        const started = await native.Downloads.enqueue({
          url: downloadUrl(user, next.id, next.kind, next.sourceId ?? next.id),
          authorization: authHeader(deviceId(), user.token),
          name: next.file,
        });
        change(next.id, { state: "running", transfer: started.id });
      } catch {
        change(next.id, { state: "failed", note: "The tablet couldn't start this transfer." });
      }
    }
  } finally {
    ticking = false;
  }
}

/// Watches the transfers while the app is open (Android carries them on when it is closed, and
/// this catches up at the next launch).
export function startRunner(): () => void {
  void tick();
  // Films saved before posters were kept get theirs now, while the server answers.
  for (const entry of saved.value) void keepArt(entry.item);
  const timer = setInterval(() => {
    if (saved.value.some((entry) => entry.state === "running" || entry.state === "queued")) void tick();
  }, 2000);
  return () => clearInterval(timer);
}

export async function refreshSpace(): Promise<void> {
  const native = await loadNative();
  const info = await native?.Downloads.info().catch(() => null);
  if (info) space.value = { free: info.freeBytes, total: info.totalBytes };
}

/// Notes where a saved film was left, to be sent to the server when it can be reached.
/// `final` is set when playback is over (not for the 10-second saves): a film watched to the end is
/// then removed from the tablet if Settings says so.
export function recordProgress(id: string, seconds: number, duration: number, final = false): void {
  const finished = isFinished(seconds, duration);
  const entry = find(id);
  if (entry) change(id, { position: finished ? 0 : Math.round(seconds) });
  const next = queueProgress(pending.value, { id, seconds: finished ? 0 : Math.round(seconds), finished, at: Date.now() });
  pending.value = next;
  save("downloads.pending", JSON.stringify(next));
  if (final && finished && deleteWatchedOn() && find(id)?.state === "done") void discard(id);
}

let flushing = false;

/// Sends the queued progress to the server, oldest first, stopping at the first failure.
export async function flushPending(): Promise<void> {
  const user = current.value;
  if (!user || flushing || !pending.value.length) return;
  flushing = true;
  try {
    for (const entry of [...pending.value].sort((a, b) => a.at - b.at)) {
      try {
        await request<unknown>(connectionOf(user), `/UserItems/${entry.id}/UserData`, {
          method: "POST",
          query: { userId: user.userId },
          body: entry.finished ? { Played: true, PlaybackPositionTicks: 0 } : { PlaybackPositionTicks: toTicks(entry.seconds) },
          timeoutMs: 6000,
        });
      } catch {
        return;
      }
      // Drop it only if nothing newer was queued for the same film meanwhile.
      const rest = pending.value.filter((other) => other.id !== entry.id || other.at > entry.at);
      pending.value = rest;
      save("downloads.pending", JSON.stringify(rest));
    }
  } finally {
    flushing = false;
  }
}
