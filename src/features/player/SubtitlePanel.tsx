import { useEffect, useState } from "preact/hooks";
import type { Session } from "../../api/auth";
import { Button } from "../../design/components/Button";
import { Drawer } from "../../design/components/Drawer";
import { Icon } from "../../design/components/Icon";
import { useAutoFocus } from "../../nav/hooks";
import { load, save } from "../../api/storage";
import { clampOffset, offsetLabel } from "../../subtitles/style";
import { describe, download, explain, LANGUAGES, search, type Found } from "../../subtitles/remote";
import { pickerLabel, type SubTrack } from "../../subtitles/tracks";

interface Props {
  session: Session;
  itemId: string;
  tracks: SubTrack[];
  /// The track in use, or null for off.
  selected: number | null;
  offset: number;
  onSelect: (index: number | null) => void;
  onOffset: (seconds: number) => void;
  onAppearance: () => void;
  /// A subtitle was downloaded: reload the film's tracks and pick the new one.
  onDownloaded: () => Promise<void>;
  onClose: () => void;
  /// Audio tracks, listed above the subtitles when there is more than one to choose from.
  audio?: { index: number; label: string }[];
  audioIndex?: number;
  onAudio?: (index: number) => void;
}

type View = "tracks" | "language" | "results";

/// The subtitle drawer: choose a track (or Off), sync it, open Appearance, or search the
/// server's subtitle plugin and download a new one.
export function SubtitlePanel({ session, itemId, tracks, selected, offset, onSelect, onOffset, onAppearance, onDownloaded, onClose, audio = [], audioIndex, onAudio }: Props) {
  const [view, setView] = useState<View>("tracks");
  const [found, setFound] = useState<Found[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useAutoFocus(view);

  const chosen = tracks.find((track) => track.index === selected);
  const drawn = !!chosen?.text;

  const lookUp = async (code: string) => {
    save("subtitleLanguage", code);
    setView("results");
    setFound(null);
    setMessage("");
    try {
      const list = await search(session, itemId, code);
      setFound(list);
      if (!list.length) setMessage("No subtitles found in that language.");
    } catch (error) {
      setFound([]);
      setMessage(explain(error));
    }
  };

  const get = async (result: Found) => {
    if (busy) return;
    setBusy(true);
    setMessage("Downloading…");
    try {
      await download(session, itemId, result.id);
      await onDownloaded();
      onClose();
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  };

  // The language last searched is the one the list opens on.
  const lastLanguage = load("subtitleLanguage");
  useEffect(() => setMessage(""), [view]);

  if (view === "language") {
    return (
      <Drawer title="Search in" onClose={onClose} onBack={() => setView("tracks")}>
        <div class="drawer-list" data-scroll="y" data-focus-group>
          {LANGUAGES.map((language) => (
            <button key={language.code} class="button drawer-option" type="button" data-focusable data-autofocus={language.code === lastLanguage || undefined} tabIndex={-1} onClick={() => void lookUp(language.code)}>
              <span class="drawer-label">{language.label}</span>
            </button>
          ))}
        </div>
      </Drawer>
    );
  }

  if (view === "results") {
    return (
      <Drawer title="Subtitles found" onClose={onClose} onBack={() => setView("language")}>
        {message && <p class="secondary drawer-note">{message}</p>}
        {!found && !message && <p class="secondary drawer-note">Searching…</p>}
        <div class="drawer-list" data-scroll="y" data-focus-group>
          {(found ?? []).map((result) => (
            <button key={result.id} class="button drawer-option drawer-result" type="button" data-focusable tabIndex={-1} onClick={() => void get(result)}>
              <span class="drawer-label">{result.name}</span>
              <span class="drawer-detail mono secondary">{describe(result)}</span>
            </button>
          ))}
          {found !== null && found.length === 0 && (
            <Button icon="arrow-left" onPress={() => setView("language")}>
              Another language
            </Button>
          )}
        </div>
      </Drawer>
    );
  }

  return (
    <Drawer title={audio.length > 1 ? "Audio & Subtitles" : "Subtitles"} onClose={onClose}>
      <div class="drawer-list" data-scroll="y" data-focus-group>
        {audio.length > 1 && (
          <>
            <p class="secondary drawer-note">Audio</p>
            {audio.map((track) => (
              <button key={track.index} class="button drawer-option" type="button" data-focusable tabIndex={-1} onClick={() => { onAudio?.(track.index); onClose(); }}>
                <span class="drawer-label">{track.label}</span>
                {track.index === audioIndex && <Icon name="check" />}
              </button>
            ))}
            <p class="secondary drawer-note">Subtitles</p>
          </>
        )}
        <button class="button drawer-option" type="button" data-focusable data-autofocus={selected === null || undefined} tabIndex={-1} onClick={() => { onSelect(null); onClose(); }}>
          <span class="drawer-label">Off</span>
          {selected === null && <Icon name="check" />}
        </button>
        {tracks.map((track) => (
          <button key={track.index} class="button drawer-option" type="button" data-focusable data-autofocus={track.index === selected || undefined} tabIndex={-1} onClick={() => { onSelect(track.index); onClose(); }}>
            <span class="drawer-label">{pickerLabel(track)}</span>
            {track.index === selected && <Icon name="check" />}
          </button>
        ))}
        {drawn && (
          <div class="drawer-sync" data-focus-group>
            <Button icon="minus" onPress={() => onOffset(clampOffset(offset - 0.1))}>
              Earlier
            </Button>
            <span class="mono">{offsetLabel(offset)}</span>
            <Button icon="plus" onPress={() => onOffset(clampOffset(offset + 0.1))}>
              Later
            </Button>
          </div>
        )}
        <Button icon="magnifying-glass" onPress={() => setView("language")}>
          Search for subtitles
        </Button>
        <Button icon="closed-captioning" onPress={onAppearance}>
          Appearance
        </Button>
      </div>
    </Drawer>
  );
}
