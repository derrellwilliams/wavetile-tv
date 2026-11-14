import { useEffect, useRef, useState } from "preact/hooks";
import type { Item } from "../../api/items";
import { children, episodeToPlay, episodes, item as fetchItem, seasons, setFavorite, setPlayed, similar, withPerson } from "../../api/library";
import { session } from "../../api/session";
import { Button } from "../../design/components/Button";
import { Menu, type Option } from "../../design/components/Menu";
import { describeChoice, languageName, loadChoice, saveChoice, type SubChoice } from "../../subtitles/choice";
import { pickerLabel, type SubTrack } from "../../subtitles/tracks";
import { refreshAll, useResource } from "../../data/resource";
import { Card } from "../browse/Card";
import { Hero } from "../browse/Hero";
import { ItemShelf, Shelf } from "../browse/Shelf";
import { Unreachable } from "../browse/Status";
import { averages, wantAverage } from "../../letterboxd/average";
import { describeSeen, useMarks } from "../../letterboxd/marks";
import { watchLog } from "../../letterboxd/store";
import { isKidsShow, overrides, setKids } from "../kids/kids";
import { useEnter } from "../shell/enter";
import { discard, enqueue, enqueueMany, enqueueUnwatched, saved } from "../../downloads/store";
import { sizeText } from "../../downloads/plan";
import { isAndroid } from "../../platform/platform";
import { openItem, play } from "../shell/route";

type Mark = "played" | "favorite";

/// One movie, show, episode, collection or person: the header with its actions, then the shelves
/// that belong to it (episodes by season, cast, more like this, what a collection holds, what a
/// person is in). Each shelf loads on its own.
export function Detail({ id }: { id: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const main = useResource(`item:${id}`, (current) => fetchItem(current, id));
  const item = main.data;
  const type = item?.type;

  const seasonList = useResource(type === "Series" ? `seasons:${id}` : null, (current) => seasons(current, id));
  const [chosen, setChosen] = useState<string | null>(null);
  // Start on the first season with something left to watch.
  const season =
    seasonList.data?.find((entry) => entry.id === chosen) ??
    seasonList.data?.find((entry) => !entry.played && entry.season !== 0) ??
    seasonList.data?.[0];
  const seasonId = season?.id;
  const episodeList = useResource(seasonId ? `episodes:${id}:${seasonId}` : null, (current) => episodes(current, id, seasonId!));
  const mine = useMarks(item?.type === "Movie" ? [item] : undefined);
  const tmdb = item?.type === "Movie" ? item.tmdb : undefined;
  useEffect(() => wantAverage(tmdb), [tmdb]);
  const alike = useResource(type === "Movie" || type === "Series" ? `similar:${id}` : null, (current) => similar(current, id));
  const held = useResource(type === "BoxSet" ? `children:${id}` : null, (current) => children(current, id));
  const credits = useResource(type === "Person" ? `person:${id}` : null, (current) => withPerson(current, id));

  // Subtitles to start with. A film or episode names a track; a show names a language, taken
  // from the episode that would play next.
  const nextEpisode = useResource(type === "Series" ? `nextep:${id}` : null, async (current) => {
    const episode = await episodeToPlay(current, id);
    return episode ? fetchItem(current, episode.id) : null;
  });
  const [choice, setChoice] = useState<SubChoice | null>(() => loadChoice(id));
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState<"menu" | "show" | null>(null);
  const [saveNote, setSaveNote] = useState("");
  useEffect(() => {
    if (!saveNote) return;
    const timer = setTimeout(() => setSaveNote(""), 6000);
    return () => clearTimeout(timer);
  }, [saveNote]);

  // Shown at once, then confirmed by the server (and put back if it refuses).
  const [local, setLocal] = useState<Partial<Record<Mark, boolean>>>({});
  useEnter(screen, !!item || main.failed);

  if (!item) return <div ref={screen} class="detail">{main.failed && <Unreachable />}</div>;

  const state: Record<Mark, boolean> = { played: local.played ?? item.played, favorite: local.favorite ?? item.favorite };
  const toggle = async (mark: Mark) => {
    const current = session.value;
    if (!current) return;
    const next = !state[mark];
    setLocal((now) => ({ ...now, [mark]: next }));
    try {
      await (mark === "played" ? setPlayed : setFavorite)(current, id, next);
      refreshAll();
    } catch {
      setLocal((now) => ({ ...now, [mark]: !next }));
    }
  };

  const start = async (resume: boolean) => {
    const current = session.value;
    if (!current) return;
    if (type === "Series") {
      // A show plays the episode to watch next.
      const episode = await episodeToPlay(current, id).catch(() => null);
      if (episode) play(episode.id, !!episode.progress, choice ?? undefined);
    } else {
      play(id, resume, choice ?? undefined);
    }
  };

  const playable = type === "Movie" || type === "Episode";
  const copy = playable ? saved.value.find((entry) => entry.id === id) : undefined;
  /// Saving to the tablet: a film or episode, or a show's episodes. Fails with a message to show.
  const keep = async (job: () => Promise<unknown>) => {
    setSaveNote("");
    try {
      await job();
    } catch (failure) {
      setSaveNote(failure instanceof Error ? failure.message : "Couldn't save this.");
    }
  };
  const saveLabel = !copy
    ? "Download"
    : copy.state === "done"
      ? "Downloaded"
      : copy.state === "failed"
        ? "Download failed"
        : copy.state === "queued"
          ? "Waiting to download"
          : `Downloading ${Math.min(99, Math.round((copy.bytes / (copy.total || copy.estimate || 1)) * 100))}%`;
  const onSave = () => {
    if (!copy) void keep(() => enqueue(item));
    else setSaving("menu");
  };
  const watchable = playable || type === "Series";
  const seriesId = type === "Episode" ? item.seriesId : undefined;
  const open = (target: Item) => openItem(target);

  const tracks: SubTrack[] = (type === "Series" ? nextEpisode.data?.subtitles : item.subtitles) ?? [];
  const subOptions: Option[] = [{ id: "default", label: "Default (your server settings)" }, { id: "off", label: "Off" }];
  if (type === "Series") {
    const seen = new Set<string>();
    for (const track of tracks) {
      const code = track.language?.toLowerCase();
      if (code && !seen.has(code)) {
        seen.add(code);
        subOptions.push({ id: `l:${code}`, label: languageName(code) });
      }
    }
  } else {
    for (const track of tracks) subOptions.push({ id: `i:${track.index}`, label: pickerLabel(track) });
  }
  const subValue = !choice ? "default" : "off" in choice ? "off" : "language" in choice ? `l:${choice.language}` : `i:${choice.index}`;
  const pickSub = (option: string) => {
    const next: SubChoice | null =
      option === "off" ? { off: true } : option.startsWith("l:") ? { language: option.slice(2) } : option.startsWith("i:") ? { index: Number(option.slice(2)) } : null;
    setChoice(next);
    saveChoice(id, next);
  };
  // Subtitles can be chosen where there is something to play and tracks to choose from.
  const hasSubs = (playable || type === "Series") && tracks.length > 0;

  return (
    <>
      <div ref={screen} class="detail" data-scroll="y">
        <Hero item={item} full average={tmdb ? averages.value.get(tmdb)?.rating : undefined} notes={[describeSeen(mine.get(item.id))]}>
          {(playable || type === "Series") && (
            <Button icon="play" onPress={() => void start(item.progress ? true : false)} autoFocus>
              {item.progress ? "Resume" : "Play"}
            </Button>
          )}
          {playable && item.progress && (
            <Button icon="arrow-counter-clockwise" onPress={() => play(id, false, choice ?? undefined)}>
              Restart
            </Button>
          )}
          {/* Movies take watched from Letterboxd, so Jellyfin's own toggle is hidden once a log is loaded. */}
          {hasSubs && (
            <Button icon="subtitles" on={!!choice} onPress={() => setPicking(true)}>
              {`Subtitles · ${describeChoice(tracks, choice)}`}
            </Button>
          )}
          {isAndroid && playable && (
            <Button icon={copy?.state === "done" ? "check" : "download-simple"} on={copy?.state === "done"} onPress={onSave}>
              {saveLabel}
            </Button>
          )}
          {isAndroid && type === "Series" && (
            <Button icon="download-simple" onPress={() => setSaving("show")}>
              Download
            </Button>
          )}
          {watchable && !(type === "Movie" && watchLog.value.length > 0) && (
            <Button icon={state.played ? "check" : "eye"} on={state.played} onPress={() => void toggle("played")} autoFocus={!playable && type !== "Series"}>
              Watched
            </Button>
          )}
          <Button icon={state.favorite ? "check" : "heart"} on={state.favorite} onPress={() => void toggle("favorite")} autoFocus={!watchable && !playable}>
            Favorite
          </Button>
          {type === "Series" && (
            <Button icon={isKidsShow(item, overrides.value) ? "check" : "balloon"} on={isKidsShow(item, overrides.value)} onPress={() => setKids(item, !isKidsShow(item, overrides.value))}>
              Kids
            </Button>
          )}
          {seriesId && (
            <Button icon="television-simple" onPress={() => openItem({ id: seriesId })}>
              Go to show
            </Button>
          )}
        </Hero>

        {type === "Series" && seasonList.data && seasonList.data.length > 1 && (
          <Shelf title="Seasons">
            {seasonList.data.map((entry) => (
              <Button key={entry.id} icon={entry.id === seasonId ? "check" : undefined} on={entry.id === seasonId} onPress={() => setChosen(entry.id)}>
                {entry.name}
              </Button>
            ))}
          </Shelf>
        )}
        {type === "Series" && (
          <ItemShelf title={season?.name ?? "Episodes"} items={episodeList.data} shape="thumb" onOpen={open} ownTitle />
        )}
        <ItemShelf title="In this collection" items={held.data} shape="poster" onOpen={open} />
        <ItemShelf title="Movies and shows" items={credits.data} shape="poster" onOpen={open} />
        {item.people && (
          <Shelf title="Cast and crew">
            {item.people.map((person) => (
              <Card
                key={person.id}
                shape="person"
                art={person.art}
                title={person.name}
                detail={person.role}
                onPress={() => openItem(person)}
              />
            ))}
          </Shelf>
        )}
        <ItemShelf title="More like this" items={alike.data} shape="poster" onOpen={open} />
      </div>
      {/* Outside the scrolling page, so moving through the drawer never scrolls what is under it. */}
      {saveNote && (
        <p class="offline mono" role="status">
          {saveNote}
        </p>
      )}
      {saving === "menu" && copy && (
        <Menu
          title={copy.state === "done" ? "Saved on this tablet" : "Download"}
          options={[
            { id: "remove", label: copy.state === "done" ? `Delete and free ${sizeText(copy.bytes)}` : "Cancel and remove" },
            ...(copy.state === "failed" ? [{ id: "again", label: "Try again" }] : []),
            { id: "keep", label: "Keep it" },
          ]}
          value="keep"
          onPick={(option) => {
            if (option === "remove") void discard(id);
            if (option === "again") {
              void discard(id).then(() => keep(() => enqueue(item)));
            }
          }}
          onClose={() => setSaving(null)}
        />
      )}
      {saving === "show" && (
        <Menu
          title="Download episodes"
          options={[
            ...(season && episodeList.data?.length ? [{ id: "season", label: `${season.name} (${episodeList.data.length} episodes)` }] : []),
            { id: "unwatched", label: "All unwatched episodes" },
          ]}
          value=""
          onPick={(option) => {
            if (option === "season" && episodeList.data) void keep(() => enqueueMany(episodeList.data!));
            if (option === "unwatched") void keep(() => enqueueUnwatched(id));
          }}
          onClose={() => setSaving(null)}
        />
      )}
      {picking && <Menu title="Subtitles" options={subOptions} value={subValue} onPick={pickSub} onClose={() => setPicking(false)} />}
    </>
  );
}
