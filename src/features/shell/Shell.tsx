import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { Session } from "../../api/auth";
import { everything } from "../../api/library";
import { offline, useResource } from "../../data/resource";
import { setLibraryIds } from "../../letterboxd/average";
import { refreshFeed } from "../../letterboxd/feed";
import { applySeed } from "../../letterboxd/seed";
import { Icon } from "../../design/components/Icon";
import type { IconName } from "../../design/icons.gen";
import { focusFirst, focusIfUsable, onEdge } from "../../nav/focus";
import { useBack } from "../../nav/hooks";
import { flushPending, startRunner } from "../../downloads/store";
import { input, isAndroid } from "../../platform/platform";
import { Account } from "../account/Account";
import { Detail } from "../detail/Detail";
import { Downloads } from "../downloads/Downloads";
import { Home } from "../home/Home";
import { KidsHome } from "../kids/KidsHome";
import { Library } from "../library/Library";
import { Search } from "../search/Search";
import "../browse/browse.css";
import "../player/player.css";
import { Player } from "../player/Player";
import { ACTIVE } from "./enter";
import { goBack, pages, play, playing, returnTo, tab, type Tab } from "./route";

const TABS: { id: Tab; icon: IconName; label: string }[] = [
  { id: "home", icon: "house", label: "Home" },
  { id: "movies", icon: "film-strip", label: "Movies" },
  { id: "shows", icon: "television-simple", label: "Shows" },
  { id: "kids", icon: "balloon", label: "Kids" },
  { id: "search", icon: "magnifying-glass", label: "Search" },
  // Saving films to the device is the tablet's: the TV has no such tab.
  ...(isAndroid ? [{ id: "downloads" as const, icon: "download-simple" as const, label: "Downloads" }] : []),
  { id: "account", icon: "gear-six", label: "Settings" },
];

let openedOffline = false;

const back = () => void goBack();
const loadMovies = (session: Session) => everything(session, "Movie");

interface Props {
  session: Session;
  onSetupCheck: () => void;
  onSignOut: () => void;
}

/// The signed-in app: the icon rail on the left, the chosen screen beside it, and detail pages
/// over both. Left at a screen's edge goes to the rail; Right (or OK) on the rail enters the screen.
export function Shell({ session, onSetupCheck, onSignOut }: Props) {
  const rail = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const lastInContent = useRef<Element | null>(null);
  const current = tab.value;
  const open = pages.value;
  const top = open[open.length - 1];
  const watching = playing.value;
  // On the TV the screens under a detail page are taken out of the page so the remote can't reach
  // them. On the tablet they stay, covered, so Back returns to the same scroll position.
  const covered = !!top && input.dpad;

  // Letterboxd averages are read in the background for the library's movies.
  const movies = useResource("all:Movie", loadMovies).data;
  useEffect(() => {
    if (movies) setLibraryIds(movies.flatMap((movie) => (movie.tmdb ? [movie.tmdb] : [])));
  }, [movies]);

  useEffect(() => {
    applySeed();
    void refreshFeed(true);
    const timer = setInterval(() => void refreshFeed(), 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  // The tablet: watch the transfers, send progress made offline once the server answers, and when
  // the server can't be reached at launch start on the Downloads tab (the only screen that works).
  useEffect(() => {
    if (!isAndroid) return;
    const stop = startRunner();
    void flushPending();
    const timer = setInterval(() => void flushPending(), 60 * 1000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, []);
  const away = offline.value;
  useEffect(() => {
    if (isAndroid && away && !openedOffline && tab.value === "home" && !pages.value.length && !playing.value) {
      openedOffline = true;
      tab.value = "downloads";
    }
  }, [away]);

  useBack(top || current !== "home" ? back : null);

  const enter = () => {
    if (!focusIfUsable(lastInContent.current) && content.current) focusFirst(content.current);
  };

  useEffect(
    () =>
      onEdge((direction, from) => {
        if (rail.current?.contains(from)) {
          if (direction === "right") enter();
          return true;
        }
        if (direction === "left" && content.current?.contains(from)) {
          return focusIfUsable(rail.current?.querySelector(ACTIVE));
        }
        return false;
      }),
    [],
  );

  // Back from the last detail page: the screen underneath is visible again, so return focus to
  // the card that opened it.
  const depth = open.length;
  const before = useRef(depth);
  useLayoutEffect(() => {
    if (depth === 0 && before.current > 0 && !focusIfUsable(returnTo)) enter();
    before.current = depth;
  }, [depth]);

  return (
    <div class="shell">
      <nav ref={rail} class="rail" hidden={covered} data-focus-group data-focus-manual>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            class={entry.id === current ? "rail-item is-active" : "rail-item"}
            type="button"
            data-focusable
            tabIndex={-1}
            aria-label={entry.label}
            onClick={() => {
              if (entry.id === current) enter();
              else tab.value = entry.id;
            }}
          >
            <Icon name={entry.icon} />
            <span class="rail-label">{entry.label}</span>
          </button>
        ))}
      </nav>
      <div ref={content} class="content" hidden={covered} onFocusIn={(event) => (lastInContent.current = event.target as Element)}>
        {current === "home" && <Home />}
        {current === "movies" && <Library key="Movie" type="Movie" />}
        {current === "shows" && <Library key="Series" type="Series" />}
        {current === "kids" && <KidsHome />}
        {current === "search" && <Search />}
        {current === "downloads" && <Downloads />}
        {current === "account" && <Account session={session} onSetupCheck={onSetupCheck} onSignOut={onSignOut} />}
      </div>
      {offline.value && !watching && (
        <p class="offline mono" role="status">
          Can't reach the server. Showing saved copies.
        </p>
      )}
      {watching && (
        <Player key={watching.id} id={watching.id} resume={watching.resume} subtitle={watching.subtitle} onClose={() => (playing.value = null)} onNext={(id) => play(id, false, watching.subtitle && !("index" in watching.subtitle) ? watching.subtitle : undefined)} />
      )}
      {top && <Detail key={`${depth}:${top.id}`} id={top.id} />}
    </div>
  );
}
