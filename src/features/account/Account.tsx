import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { loadNative } from "../../platform/native-load";
import { isAndroid } from "../../platform/platform";
import { versionAtLeast, type Session } from "../../api/auth";
import { Button } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Mark } from "../../design/components/Mark";
import { Menu } from "../../design/components/Menu";
import { sizeText } from "../../downloads/plan";
import { saved, space, refreshSpace } from "../../downloads/store";
import {
  autoplayOn,
  deleteWatchedOn,
  QUALITIES,
  readQuality,
  saveAutoplay,
  saveDeleteWatched,
  saveQuality,
} from "../../player/settings";
import { Connect } from "../letterboxd/Connect";
import { SubtitleStyle } from "../player/SubtitleStyle";
import { useEnter } from "../shell/enter";

interface Props {
  session: Session;
  onSetupCheck: () => void;
  onSignOut: () => void;
}

/// Settings: playback (quality, autoplay), subtitles, Letterboxd, who is signed in, and About.
/// Flags a server too old for features planned later.
export function Account({ session, onSetupCheck, onSignOut }: Props) {
  const screen = useRef<HTMLElement>(null);
  const [styling, setStyling] = useState(false);
  const [lists, setLists] = useState(false);
  const closeLists = useCallback(() => setLists(false), []);
  const [quality, setQuality] = useState(() => readQuality().id);
  const [autoplay, setAutoplay] = useState(() => autoplayOn());
  const [deleteWatched, setDeleteWatched] = useState(() => deleteWatchedOn());
  const [choosing, setChoosing] = useState(false);
  const closeChoosing = useCallback(() => setChoosing(false), []);
  useEnter(screen, !styling && !lists);
  // The tablet: is Wavetile TV the home screen (device owner)? The button below hands it back.
  const [owner, setOwner] = useState(false);
  useEffect(() => {
    if (isAndroid) void refreshSpace();
    if (isAndroid)
      void loadNative()
        .then((native) => native?.homeOwned())
        .then((value) => setOwner(!!value));
  }, []);
  const giveBackHome = async () => {
    const native = await loadNative();
    await native?.Downloads.releaseHome().catch(() => undefined);
    setOwner(false);
  };

  const missing = !versionAtLeast(session.serverVersion, 10, 9)
    ? "Scrub thumbnails need Jellyfin 10.9 and Skip Intro needs 10.10."
    : !versionAtLeast(session.serverVersion, 10, 10)
      ? "Skip Intro needs Jellyfin 10.10."
      : "";

  if (lists) return <Connect onClose={closeLists} />;
  if (styling) return <SubtitleStyle onClose={() => setStyling(false)} />;

  return (
    <main ref={screen} class="page">
      <Mark />
      <h1 class="display">Settings</h1>

      <dl class="facts">
        <dt class="secondary">User</dt>
        <dd>{session.userName}</dd>
        <dt class="secondary">Server</dt>
        <dd>{session.serverName}</dd>
        <dt class="secondary">Address</dt>
        <dd class="mono">{session.server}</dd>
        <dt class="secondary">Version</dt>
        <dd class="mono">Jellyfin {session.serverVersion}</dd>
        {isAndroid && <dt class="secondary">Downloads</dt>}
        {isAndroid && (
          <dd class="mono">
            {sizeText(saved.value.reduce((sum, entry) => sum + entry.bytes, 0))}{" "}
            used
            {space.value
              ? ` · ${sizeText(space.value.free)} free of ${sizeText(space.value.total)}`
              : ""}
          </dd>
        )}
      </dl>
      {missing && (
        <p class="notice secondary">
          <Icon name="warning" />
          {missing}
        </p>
      )}

      <div class="row actions" data-focus-group>
        <Button icon="gauge" onPress={() => setChoosing(true)} autoFocus>
          Quality ·{" "}
          {QUALITIES.find((entry) => entry.id === quality)?.label.replace(
            " (original quality)",
            "",
          )}
        </Button>
        <Button
          icon={autoplay ? "check" : "play"}
          on={autoplay}
          onPress={() => {
            saveAutoplay(!autoplay);
            setAutoplay(!autoplay);
          }}
        >
          Autoplay next episode
        </Button>
      </div>
      <div class="row actions" data-focus-group>
        {isAndroid && (
          <Button
            icon={deleteWatched ? "check" : "trash"}
            on={deleteWatched}
            onPress={() => {
              saveDeleteWatched(!deleteWatched);
              setDeleteWatched(!deleteWatched);
            }}
          >
            Delete downloads once watched
          </Button>
        )}
        <Button icon="wrench" onPress={onSetupCheck}>
          Setup check
        </Button>
        {isAndroid && owner && (
          <Button icon="house" onPress={() => void giveBackHome()}>
            Give Home back to Fire
          </Button>
        )}
        <Button icon="closed-captioning" onPress={() => setStyling(true)}>
          Subtitle appearance
        </Button>
        <Button icon="film-reel" onPress={() => setLists(true)}>
          Letterboxd
        </Button>
        <Button icon="sign-out" onPress={onSignOut}>
          Sign out
        </Button>
      </div>
      <p class="mono secondary about">
        Wavetile TV 0.1.0 · Installed apps stop opening when Developer Mode lapses:
        press Extend in the Developer Mode app on the TV about every 1000 hours.
      </p>
      {choosing && (
        <Menu
          title="Max quality"
          options={QUALITIES}
          value={quality}
          onPick={(id) => {
            saveQuality(id);
            setQuality(id);
          }}
          onClose={closeChoosing}
        />
      )}
    </main>
  );
}
