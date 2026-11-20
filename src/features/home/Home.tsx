import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { episodeCode } from "../../api/items";
import type { Session } from "../../api/auth";
import { everything, favorites, nextUp, resume } from "../../api/library";
import { Button } from "../../design/components/Button";
import { useResource } from "../../data/resource";
import { averages } from "../../letterboxd/average";
import { useMarks } from "../../letterboxd/marks";
import { withoutDismissed } from "../browse/dismissed";
import { Hero } from "../browse/Hero";
import { useItemMenu } from "../browse/ItemMenu";
import { ItemShelf } from "../browse/Shelf";
import { Status, Unreachable } from "../browse/Status";
import { isKidsShow, looksKids, useKids } from "../kids/kids";
import { useEnter } from "../shell/enter";
import { openItem, play } from "../shell/route";
import { recentlyAdded, unwatchedMovies } from "./shelves";
import { topUnwatched } from "./spotlight";

/// How long each pick of the carousel stays up before the next one.
const SPOTLIGHT_MS = 12_000;

const allMovies = (session: Session) => everything(session, "Movie");

/// Home: a spotlight, then four shelves. The spotlight is what you were watching, else a carousel
/// of the best-liked movies you haven't seen. Each shelf loads on its own from the last visit's
/// copy and refreshes behind it; a shelf with nothing in it isn't drawn. Kids' shows live on the
/// Kids tab and stay off Home.
export function Home() {
  const screen = useRef<HTMLDivElement>(null);
  const watching = useResource("resume", resume);
  const next = useResource("nextup", nextUp);
  const loved = useResource("favorites", favorites);
  const library = useResource("all:Movie", allMovies);
  const kids = useKids();
  const marks = useMarks(library.data);
  const known = averages.value;

  const menu = useItemMenu();
  const continuing = withoutDismissed(kids.without(watching.data));
  const upNext = kids.without(next.data);
  const favorite = kids.without(loved.data);
  const unseen = useMemo(() => unwatchedMovies(library.data, marks, known), [library.data, marks, known]);
  const added = useMemo(
    () =>
      recentlyAdded(
        library.data,
        kids.shows?.filter((show) => !isKidsShow(show, kids.choices)),
      ),
    [library.data, kids.shows, kids.choices],
  );

  // Something to continue wins; a kids' movie in progress doesn't count. While the kids' list is
  // still loading, the spotlight waits rather than flashing the wrong thing.
  const resuming = continuing?.find((item) => !(item.type === "Movie" && looksKids(item)));
  const pending = !!watching.data?.length && continuing === undefined;
  const top = useMemo(() => topUnwatched(library.data, marks, known), [library.data, marks, known]);
  const carousel = resuming || pending ? [] : top;
  const [turn, setTurn] = useState(0);
  const at = carousel.length ? turn % carousel.length : 0;
  useEffect(() => {
    if (carousel.length < 2) return;
    const timer = setTimeout(() => setTurn(at + 1), SPOTLIGHT_MS);
    return () => clearTimeout(timer);
  }, [carousel.length, at]);

  const all = [watching, next, loved, library];
  const ready = all.some((shelf) => shelf.data !== undefined);
  const settled = all.every((shelf) => shelf.data !== undefined || shelf.failed);
  const empty = [continuing, upNext, favorite, unseen, added].every((list) => !list?.length);
  useEnter(screen, ready && !empty);
  useEnter(screen, settled && empty);

  const spotlight = pending ? undefined : (resuming ?? carousel[at] ?? added.find((item) => item.backdrop) ?? added[0]);
  const kicker = !spotlight
    ? undefined
    : spotlight === resuming
      ? spotlight.type === "Episode" && episodeCode(spotlight)
        ? `Continue watching  ·  ${episodeCode(spotlight)}`
        : "Continue watching"
      : carousel.length
        ? `Top rated on Letterboxd, not watched yet  ·  ${at + 1} of ${carousel.length}`
        : "Recently added";

  return (
    <>
      <div ref={screen} class="screen has-hero" data-scroll="y">
        {spotlight && (
          <Hero item={spotlight} kicker={kicker} average={spotlight.tmdb ? known.get(spotlight.tmdb)?.rating : undefined}>
            {(spotlight.type === "Movie" || spotlight.type === "Episode") && (
              <Button
                icon="play"
                onPress={() => play(spotlight.id, !!spotlight.progress)}
                onHold={() => menu.ask(spotlight, spotlight === resuming)}
                autoFocus
              >
                {spotlight.progress ? "Resume" : "Play"}
              </Button>
            )}
            <Button
              icon="info"
              iconOnly
              onPress={() => openItem(spotlight)}
              autoFocus={spotlight.type !== "Movie" && spotlight.type !== "Episode"}
            >
              Details
            </Button>
          </Hero>
        )}
        <ItemShelf title="New to You" items={unseen} shape="poster" onOpen={openItem} onHold={menu.ask} />
        <ItemShelf title="Up Next" items={upNext} shape="thumb" onOpen={openItem} onHold={menu.ask} />
        <ItemShelf title="Recently Added" items={added} shape="poster" onOpen={openItem} onHold={menu.ask} />
        <ItemShelf title="Favorites" items={favorite} shape="poster" onOpen={openItem} onHold={menu.ask} />
        {settled && empty && (all.every((shelf) => shelf.failed) ? <Unreachable /> : <Status title="Nothing in the library yet" />)}
      </div>
      {/* Outside the scrolling screen, so moving through the drawer never scrolls what is under it. */}
      {menu.menu}
    </>
  );
}
