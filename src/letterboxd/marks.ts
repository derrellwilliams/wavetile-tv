import { useMemo } from "preact/hooks";
import type { Item } from "../api/items";
import { entries, type Entry } from "./feed";
import type { Seen } from "./log";
import { matchLibrary } from "./match";
import { watchLog } from "./store";

const NONE = new Map();

/// What the Letterboxd history says about each movie in `library`, by item id. Empty until an
/// export has been loaded. Matching 600 films takes a few milliseconds, so it runs when either
/// side changes.
export function useMarks(library: readonly Item[] | undefined) {
  const log = watchLog.value;
  const recent = entries.value;
  return useMemo(() => (library && (log.length || recent.length) ? withFeed(matchLibrary(log, library as Item[]).byItem, library, recent) : NONE), [library, log, recent]);
}

/// The export's matches, with the recent feed laid over them. Feed entries match by TMDB ID, so
/// they also cover films the export never had; where both have the film the feed is newer.
export function withFeed(base: Map<string, Seen>, library: readonly Item[], recent: readonly Entry[]): Map<string, Seen> {
  if (!recent.length) return base;
  const byTmdb = new Map(recent.map((entry) => [entry.tmdb, entry]));
  const out = new Map(base);
  for (const movie of library) {
    const entry = movie.tmdb ? byTmdb.get(movie.tmdb) : undefined;
    if (!entry) continue;
    const before = out.get(movie.id);
    const last = entry.date && (!before?.last || entry.date >= before.last) ? entry.date : before?.last;
    out.set(movie.id, {
      name: before?.name ?? movie.name,
      year: before?.year ?? movie.year ?? 0,
      uri: before?.uri ?? "",
      watched: true,
      rating: entry.rating ?? before?.rating,
      last,
      rewatches: (before?.rewatches ?? 0) + (entry.rewatch && (!before?.last || (entry.date ?? "") > before.last) ? 1 : 0),
      watchlist: false,
    });
  }
  return out;
}

/// One mark of the viewer's own history with a film: an icon, a short text beside it, and the
/// full sentence for screen readers.
export interface SeenMark {
  icon: "star" | "eye" | "arrow-clockwise" | "bookmark-simple";
  text: string;
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Oct 31" this year, "Oct 31, 2024" before it. `date` is the log's YYYY-MM-DD; anything else
/// is shown as it is.
export function shortDate(date: string, thisYear = new Date().getFullYear()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return date;
  const day = `${month} ${Number(match[3])}`;
  return Number(match[1]) === thisYear ? day : `${day}, ${match[1]}`;
}

/// The viewer's own marks for a film's detail page (their rating, when they last watched it,
/// rewatches, the watchlist); empty when the log has nothing on it.
export function seenMarks(film: { watched: boolean; rating?: number; last?: string; rewatches: number; watchlist: boolean } | undefined, thisYear?: number): SeenMark[] {
  if (!film) return [];
  const marks: SeenMark[] = [];
  if (film.rating !== undefined) marks.push({ icon: "star", text: String(film.rating), label: `You rated it ${film.rating} of 5` });
  if (film.watched) {
    const when = film.last ? shortDate(film.last, thisYear) : "";
    marks.push({ icon: "eye", text: when || "Watched", label: when ? `Watched ${when}` : "Watched" });
  }
  if (film.rewatches > 0) marks.push({ icon: "arrow-clockwise", text: `${film.rewatches}×`, label: `Rewatched ${film.rewatches} time${film.rewatches === 1 ? "" : "s"}` });
  if (film.watchlist) marks.push({ icon: "bookmark-simple", text: "Watchlist", label: "On your watchlist" });
  return marks;
}
