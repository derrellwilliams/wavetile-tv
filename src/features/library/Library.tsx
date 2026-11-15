import type { ComponentChildren } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";
import type { Session } from "../../api/auth";
import { everything } from "../../api/library";
import { load, save } from "../../api/storage";
import { Button } from "../../design/components/Button";
import { Menu, type Option } from "../../design/components/Menu";
import { useResource } from "../../data/resource";
import { Grid } from "../browse/Grid";
import { Status, Unreachable } from "../browse/Status";
import { useEnter } from "../shell/enter";
import { openItem } from "../shell/route";
import { averages } from "../../letterboxd/average";
import { useMarks } from "../../letterboxd/marks";
import { useItemMenu } from "../browse/ItemMenu";
import { isKidsShow, overrides } from "../kids/kids";
import { Segments, type Segment } from "../../design/components/Segments";
import { arrange, decadesOf, DEFAULT_VIEW, isFiltered, MOVIE_VIEW, readView, SORTS, watched, type Only, type Seen, type SortKey, type View } from "./arrange";

/// Kids is the shows the Kids tab holds; Series is the rest, so a show is on one tab only.
type Kind = "Movie" | "Series" | "Kids";
type Picking = "sort" | "decade" | null;

const SEEN_CHOICES: Segment<Seen>[] = [
  { id: "unwatched", label: "Unwatched", icon: "eye-slash" },
  { id: "watched", label: "Watched", icon: "eye" },
];
const ONLY_CHOICES: Segment<Only>[] = [
  { id: "", label: "All", icon: "film-strip" },
  { id: "favorites", label: "Favorites", icon: "heart" },
  { id: "watchlist", label: "Watchlist", icon: "bookmark-simple" },
];

const loaders: Record<Kind, (session: Session) => ReturnType<typeof everything>> = {
  Movie: (session) => everything(session, "Movie"),
  Series: (session) => everything(session, "Series"),
  Kids: (session) => everything(session, "Series"),
};

/// Movies or Shows (or Kids, which brings its own `intro` shelves above the grid): the whole library as a poster grid, with the order and filters chosen from
/// the row above it. The choice is remembered per library. Movies have their own set: sort, Unwatched / Watched (Letterboxd's
/// state once a log is loaded) and All / Favorites / Watchlist.
export function Library({ type, intro, hero, after }: { type: Kind; intro?: ComponentChildren; hero?: boolean; after?: ComponentChildren }) {
  const screen = useRef<HTMLDivElement>(null);
  const library = useResource(`all:${type === "Movie" ? "Movie" : "Series"}`, loaders[type]);
  const choices = overrides.value;
  const itemMenu = useItemMenu();
  const movies = type === "Movie";
  const base = movies ? MOVIE_VIEW : DEFAULT_VIEW;
  // Movies moved to a new key when their filters changed, so they open on the new defaults once.
  const key = movies ? "view.Movie.2" : `view.${type}`;
  const [view, setView] = useState<View>(() => readView(load(key), base));
  const [picking, setPicking] = useState<Picking>(null);

  const all = useMemo(
    () => (type === "Movie" ? library.data : library.data?.filter((item) => isKidsShow(item, choices) === (type === "Kids"))),
    [library.data, type, choices],
  );
  const marks = useMarks(type === "Movie" ? all : undefined);
  const logged = marks.size > 0;
  const known = averages.value;
  // Averages arrive one by one; the order only follows them while sorting by them.
  const byAverage = view.sort === "average" ? known : null;
  const shown = useMemo(
    () =>
      arrange(all ?? [], view, marks, (item) => (item.tmdb ? known.get(item.tmdb)?.rating ?? undefined : undefined))
        // Movies show Letterboxd's watched state, not Jellyfin's, once a log is loaded.
        .map((item) => (item.type === "Movie" && logged && item.played !== watched(item, marks) ? { ...item, played: watched(item, marks) } : item)),
    [all, view, marks, byAverage, logged],
  );
  const decades = useMemo(() => decadesOf(all ?? []), [all]);
  useEnter(screen, all !== undefined || library.failed);

  const change = (next: Partial<View>) => {
    const updated = { ...view, ...next };
    setView(updated);
    save(key, JSON.stringify(updated));
    if (screen.current) screen.current.scrollTop = 0;
  };

  const sorts = SORTS.filter((sort) => (movies || (sort.id !== "runtime" && sort.id !== "average")) && (logged || (sort.id !== "mine" && sort.id !== "seen")));
  const sortLabel = sorts.find((sort) => sort.id === view.sort)?.label ?? "Name";
  // The watchlist comes from the Letterboxd log, so without one there is nothing to show.
  const onlyChoices = logged ? ONLY_CHOICES : ONLY_CHOICES.filter((choice) => choice.id !== "watchlist");
  const menus: Record<Exclude<Picking, null>, { title: string; options: Option[]; value: string; pick: (id: string) => void }> = {
    sort: { title: "Sort by", options: sorts, value: view.sort, pick: (id) => change({ sort: id as SortKey }) },
    decade: {
      title: "Decade",
      options: [{ id: "", label: "Any decade" }, ...decades.map((decade) => ({ id: decade, label: `${decade}s` }))],
      value: view.decade,
      pick: (decade) => change({ decade }),
    },
  };
  const menu = picking && menus[picking];
  const noun = type === "Movie" ? "movies" : type === "Kids" ? "kids' shows" : "shows";

  return (
    <>
      <div ref={screen} class={hero ? "screen has-hero" : "screen"} data-scroll="y">
        {intro}
        <header class="screen-head" data-scroll-anchor>
          <div class="title-row">
            <h1 class="display">{type === "Movie" ? "Movies" : type === "Kids" ? "All kids' shows" : "Shows"}</h1>
            {all && <span class="mono secondary">{shown.length === all.length ? all.length : `${shown.length} of ${all.length}`}</span>}
          </div>
          {movies ? (
            <div class="row filters" data-focus-group>
              <Button icon="sort-ascending" onPress={() => setPicking("sort")}>
                {sortLabel}
              </Button>
              <Segments label="Watched" options={SEEN_CHOICES} value={view.seen || "unwatched"} onPick={(seen) => change({ seen })} />
              <Segments label="Show" options={onlyChoices} value={view.only} onPick={(only) => change({ only })} />
            </div>
          ) : (
            <div class="row" data-focus-group>
              <Button icon="sort-ascending" onPress={() => setPicking("sort")}>
                {sortLabel}
              </Button>
              <Button icon={view.decade ? "check" : "calendar-blank"} on={!!view.decade} onPress={() => setPicking("decade")}>
                {view.decade ? `${view.decade}s` : "Decade"}
              </Button>
              <Button icon={view.seen ? "check" : "eye"} on={!!view.seen} onPress={() => change({ seen: view.seen ? "" : "unwatched" })}>
                Unwatched
              </Button>
              <Button icon={view.only ? "check" : "heart"} on={!!view.only} onPress={() => change({ only: view.only ? "" : "favorites" })}>
                Favorites
              </Button>
            </div>
          )}
        </header>

        {all && shown.length > 0 && <Grid items={shown} onOpen={openItem} onHold={itemMenu.ask} autoFocus={!hero} />}
        {all && shown.length === 0 && (
          <Status title={isFiltered(view, base) ? `No ${noun} match these filters` : `No ${noun} in the library yet`}>
            {isFiltered(view, base) && (
              <div class="row" data-focus-group>
                <Button onPress={() => change({ ...base, sort: view.sort })}>Clear filters</Button>
              </div>
            )}
          </Status>
        )}
        {!all && library.failed && <Unreachable />}
      </div>
      {/* Outside the scrolling screen, so moving through the drawer never scrolls what is under it. */}
      {menu && <Menu title={menu.title} options={menu.options} value={menu.value} onPick={menu.pick} onClose={() => setPicking(null)} />}
      {itemMenu.menu}
      {after}
    </>
  );
}
