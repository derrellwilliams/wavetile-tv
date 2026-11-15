/// Sorting and filtering a library on the TV. The whole list is already in memory (and in the
/// cache), so changing the order or a filter never waits for the server.
import type { Item } from "../../api/items";
import type { Seen as Logged } from "../../letterboxd/log";

/// What the user's Letterboxd history says about each movie, by library item id.
export type Marks = ReadonlyMap<string, Logged>;

export type SortKey = "name" | "added" | "year" | "rating" | "runtime" | "mine" | "seen" | "average";
/// Watched state: Letterboxd's for movies once a log is loaded, otherwise Jellyfin's.
export type Seen = "" | "watched" | "unwatched";
/// A narrower set: favorites in Jellyfin, or the Letterboxd watchlist.
export type Only = "" | "favorites" | "watchlist";
const SEENS: readonly string[] = ["", "watched", "unwatched"];
const ONLYS: readonly string[] = ["", "favorites", "watchlist"];

export interface View {
  sort: SortKey;
  /// First year of the decade ("1990"), or "" for any.
  decade: string;
  seen: Seen;
  only: Only;
}

export const DEFAULT_VIEW: View = { sort: "name", decade: "", seen: "", only: "" };
/// Movies open on the best-rated films you haven't seen yet.
export const MOVIE_VIEW: View = { sort: "average", decade: "", seen: "unwatched", only: "" };

export const SORTS: { id: SortKey; label: string }[] = [
  { id: "average", label: "Letterboxd average" },
  { id: "name", label: "Name" },
  { id: "added", label: "Date added" },
  { id: "year", label: "Year" },
  { id: "rating", label: "Rating" },
  { id: "runtime", label: "Runtime" },
  { id: "mine", label: "Your rating" },
  { id: "seen", label: "Date you watched" },
];

/// The value a sort compares, and whether larger comes first. Name is handled apart.
/// The Letterboxd average for a library item, if read yet.
export type Averages = (item: Item) => number | undefined;

type Of = (item: Item, marks: Marks, averages: Averages) => number | undefined;
const BY: Record<Exclude<SortKey, "name">, { of: Of; descending: boolean }> = {
  added: { of: (item) => item.added, descending: true },
  year: { of: (item) => item.year, descending: true },
  rating: { of: (item) => item.rating, descending: true },
  runtime: { of: (item) => item.minutes, descending: false },
  mine: { of: (item, marks) => marks.get(item.id)?.rating, descending: true },
  average: { of: (item, _marks, averages) => averages(item), descending: true },
  seen: { of: (item, marks) => (marks.get(item.id)?.last ? Date.parse(marks.get(item.id)!.last!) : undefined), descending: true },
};

function byName(a: Item, b: Item): number {
  return a.sortName < b.sortName ? -1 : a.sortName > b.sortName ? 1 : 0;
}

const decadeOf = (item: Item) => (item.year === undefined ? "" : String(Math.floor(item.year / 10) * 10));

/// Whether any filter differs from where this library starts (`base`), so "Clear filters" has something to undo.
export function isFiltered(view: View, base: View = DEFAULT_VIEW): boolean {
  return view.decade !== base.decade || view.seen !== base.seen || view.only !== base.only;
}

/// Letterboxd is the source of truth for movies once a log is loaded; Jellyfin's flag is only
/// used for shows, or for movies when there is no log.
export function watched(item: Item, marks: Marks): boolean {
  return marks.size > 0 && item.type === "Movie" ? !!marks.get(item.id)?.watched : item.played;
}

/// The items to show, in order. Items missing the value being sorted on go last; ties go by name.
export function arrange(items: readonly Item[], view: View, marks: Marks = new Map(), averages: Averages = () => undefined): Item[] {
  const shown = items.filter(
    (item) =>
      (!view.decade || decadeOf(item) === view.decade) &&
      (!view.seen || watched(item, marks) === (view.seen === "watched")) &&
      (view.only !== "favorites" || item.favorite) &&
      (view.only !== "watchlist" || !!marks.get(item.id)?.watchlist),
  );
  if (view.sort === "name") return shown.sort(byName);
  const { of, descending } = BY[view.sort];
  return shown.sort((a, b) => {
    const x = of(a, marks, averages);
    const y = of(b, marks, averages);
    if (x === y) return byName(a, b);
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    return descending ? y - x : x - y;
  });
}

/// Every decade in the list, newest first.
export function decadesOf(items: readonly Item[]): string[] {
  const all = new Set<string>();
  for (const item of items) if (item.year !== undefined) all.add(decadeOf(item));
  return [...all].sort((a, b) => Number(b) - Number(a));
}

/// A saved view read back from storage: anything unexpected falls back to `base`.
export function readView(raw: string | null, base: View = DEFAULT_VIEW): View {
  if (!raw) return base;
  try {
    const saved = JSON.parse(raw) as Partial<Record<keyof View, unknown>> | null;
    if (!saved || typeof saved !== "object") return base;
    const old = saved as { unwatched?: unknown; favorites?: unknown };
    return {
      sort: SORTS.some((sort) => sort.id === saved.sort) ? (saved.sort as SortKey) : base.sort,
      decade: typeof saved.decade === "string" && /^\d{4}$/.test(saved.decade) ? saved.decade : base.decade,
      // Views saved before `seen` and `only` kept them as two switches.
      seen: typeof saved.seen === "string" && SEENS.includes(saved.seen) ? (saved.seen as Seen) : old.unwatched === true ? "unwatched" : base.seen,
      only: typeof saved.only === "string" && ONLYS.includes(saved.only) ? (saved.only as Only) : old.favorites === true ? "favorites" : base.only,
    };
  } catch {
    return base;
  }
}
