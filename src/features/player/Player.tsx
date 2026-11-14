import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../../api/auth";
import { episodeCode, type Item } from "../../api/items";
import { episodeAfter, item as fetchItem } from "../../api/library";
import { session as current } from "../../api/session";
import { refreshAll } from "../../data/resource";
import { flushPending, nextSaved, playable, recordProgress, savedCues } from "../../downloads/store";
import { startPosition, type Saved } from "../../downloads/plan";
import { loadNative } from "../../platform/native-load";
import { Button } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Menu } from "../../design/components/Menu";
import { focusIfUsable, onKey, pushScope } from "../../nav/focus";
import { useBack } from "../../nav/hooks";
import { keepAwake } from "../../platform/awake";
import { input, isAndroid } from "../../platform/platform";
import { attachHls, nativeHls } from "../../player/hls";
import { plan, PlaybackError, reportProgress, subtitleCues, reportStart, reportStop, segments as fetchSegments, trickplay as fetchTrickplay, trickplayUrl, type Plan, type Report } from "../../player/playback";
import { chapterAt } from "../../player/chapters";
import { activeSegment, skipLabel, type Segment } from "../../player/segments";
import { clock, scrubTarget } from "../../player/scrub";
import { autoplayOn, QUALITIES, readQuality } from "../../player/settings";
import { isBurned } from "../../subtitles/tracks";
import { resolveChoice, type SubChoice } from "../../subtitles/choice";
import { type Cue } from "../../subtitles/cues";
import { readOffset, saveOffset, subtitleStyle } from "../../subtitles/style";
import { SubtitlePanel } from "./SubtitlePanel";
import { SubtitleStyle } from "./SubtitleStyle";
import { SubtitleView, useActiveLines } from "./SubtitleView";
import type { TrickInfo } from "../../player/trickplay";
import { thumbAt } from "../../player/trickplay";

interface Props {
  id: string;
  /// Start where it was left rather than from the beginning.
  resume: boolean;
  /// What was chosen on the detail page; otherwise the server's own subtitle settings apply.
  subtitle?: SubChoice;
  onClose: () => void;
  /// Another episode takes over (autoplay, or "Play now").
  onNext: (id: string) => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const OSD_MS = 5000;
const SCRUB_COMMIT_MS = 500;
const PROGRESS_MS = 10000;
const DIM_AFTER_MS = 60000;
const NEXT_WITHIN = 20;
const LEAVE_WAIT_MS = 1500;

const TAP_MS = 300;
const TAP_SIDE = 0.35;

const KEY = { left: 37, up: 38, right: 39, down: 40, ok: 13, play: 415, pause: 19, toggle: 10252, stop: 413, rewind: 412, forward: 417 };

/// "Subtitles" when off; the language when on, so the state reads without relying on a border.
function subButtonLabel(track: { label: string; language?: string } | undefined): string {
  if (!track) return "Subtitles";
  let name = track.label;
  try {
    const known = track.language && new Intl.DisplayNames(["en"], { type: "language" }).of(track.language);
    if (known && known !== track.language) name = known;
  } catch {
    // an odd language code: fall back to the track's own label
  }
  return `Subtitles · ${name.length > 18 ? name.slice(0, 17) + "…" : name}`;
}

type Menus = "audio" | "speed" | "subs" | "style" | "chapters" | "quality" | "version" | null;

/// Full-screen playback. The OSD (title, controls, seek bar) shows on Up, Down, a pointer move or
/// a pause and hides itself; while it is hidden Left and Right seek and OK pauses. Progress goes
/// to the server every 10 s, on pause and seek, and when leaving.
export function Player({ id, resume, subtitle: chosen, onClose, onNext }: Props) {
  // Handlers registered with the focus engine must keep one identity, so the parent's callbacks
  // are reached through refs.
  const closer = useRef(onClose);
  closer.current = onClose;
  const advance = useRef(onNext);
  advance.current = onNext;
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [item, setItem] = useState<Item | null>(null);
  const [active, setActive] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [start, setStart] = useState(0);
  const [segs, setSegs] = useState<Segment[]>([]);
  const [trick, setTrick] = useState<TrickInfo | null>(null);
  const [next, setNext] = useState<Item | null>(null);
  const [skippedNext, setSkippedNext] = useState(false);

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [osd, setOsd] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [menu, setMenu] = useState<Menus>(null);
  const [stats, setStats] = useState(false);
  const [dim, setDim] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [sub, setSub] = useState<number | null>(null);
  const [cues, setCues] = useState<Cue[]>([]);
  const [offset, setOffset] = useState(() => readOffset(id));
  const [note, setNote] = useState("");
  // The highest quality asked of the server; starts at the Settings choice, and can be changed
  // for this film from the player.
  const [quality, setQuality] = useState(() => readQuality().id);
  // The tablet plays converted streams through hls.js when its WebView can't play HLS itself, and
  // falls back to it when the native player fails.
  const [useHls, setUseHls] = useState(() => isAndroid && !nativeHls());

  // Latest values for handlers that outlive a render.
  const live = useRef({ time: 0, duration: 0, paused: false, osd: false, scrub: null as number | null, plan: null as Plan | null, leaving: false, next: null as Item | null, prompt: null as (() => void) | null, retried: false, sub: null as number | null, quality: readQuality().id });
  live.current.time = time;
  live.current.duration = duration;
  live.current.paused = paused;
  live.current.osd = osd;
  live.current.scrub = scrub;
  live.current.plan = active;
  live.current.leaving = leaving;
  live.current.sub = sub;
  live.current.quality = quality;
  live.current.next = skippedNext ? null : next;

  const autoplay = autoplayOn();

  // The tablet's screen stays on while a film plays and may sleep again when it is paused or closed.
  useEffect(() => {
    keepAwake(!paused);
    return () => keepAwake(false);
  }, [paused]);

  const viaHls = isAndroid && useHls && active?.method === "Transcode";
  const streamUrl = active?.url;
  useEffect(() => {
    if (!viaHls || !streamUrl || leaving) return;
    const element = video.current;
    if (!element) return;
    let gone = false;
    let release = () => {};
    void attachHls(element, streamUrl, start, () => !gone && void onVideoError(true)).then((stop) => {
      if (gone) stop();
      else release = stop;
    });
    return () => {
      gone = true;
      release();
    };
  }, [viaHls, streamUrl, leaving]);

  const report = useCallback((): Report | null => {
    const now = live.current;
    return now.plan && { itemId: id, sourceId: now.plan.source.id, playSessionId: now.plan.playSessionId, method: now.plan.method, seconds: now.time, paused: now.paused, audioIndex: now.plan.audioIndex, subtitleIndex: now.sub };
  }, [id]);

  const progress = useCallback(() => {
    if (live.current.leaving) return; // a late pause event must not follow the stop report
    if (live.current.plan?.local) {
      recordProgress(id, live.current.time, live.current.duration);
      return;
    }
    const user = current.value;
    const body = report();
    if (user && body) void reportProgress(user, body);
  }, [report]);

  /// Stops reporting, then runs `then` (once the server has the position, or after a short wait).
  const leave = useCallback(
    (then: () => void) => {
      if (live.current.leaving) return;
      live.current.leaving = true;
      setLeaving(true);
      video.current?.pause();
      const user = current.value;
      const body = report();
      let sent: Promise<void> = Promise.resolve();
      if (live.current.plan?.local) {
        // A saved copy: note where it stopped, and send it to the server if that can be reached.
        recordProgress(id, live.current.time, live.current.duration, true);
        sent = flushPending();
      } else if (user && body) {
        sent = reportStop(user, body);
      }
      void Promise.race([sent, new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS))]).then(() => {
        refreshAll();
        then();
      });
    },
    [report, id],
  );

  const close = useCallback(() => leave(() => closer.current()), [leave]);

  // Back hides the OSD first, then leaves.
  const back = useCallback(() => {
    if (live.current.osd && !live.current.paused) setOsd(false);
    else close();
  }, [close]);
  useBack(back);

  useEffect(() => (root.current ? pushScope(root.current) : undefined), []);

  // Load what to play.
  const begin = useCallback(
    async (user: Session, seconds: number, options: { audioIndex?: number; subtitleIndex?: number; transcode?: boolean; sourceId?: string; quality?: string } = {}) => {
      try {
        const bitrate = (QUALITIES.find((entry) => entry.id === (options.quality ?? live.current.quality)) ?? QUALITIES[0]!).bitrate;
        const made = await plan(user, id, { startSeconds: seconds, maxBitrate: bitrate, sourceId: live.current.plan?.source.id, ...options });
        setStart(seconds);
        setActive(made);
        setWaiting(true);
        return made;
      } catch (failure) {
        setError(failure instanceof PlaybackError ? failure.message : "Couldn't start playback. Check the server and try again.");
        return null;
      }
    },
    [id],
  );

  useEffect(() => {
    const copy = playable(id);
    if (copy) return playSaved(copy);
    const user = current.value;
    if (!user) return;
    let gone = false;
    void (async () => {
      let found: Item;
      try {
        found = await fetchItem(user, id);
      } catch {
        if (!gone) setError("Couldn't load this from the server.");
        return;
      }
      if (gone) return;
      setItem(found);
      // A choice made on the detail page: a track (or Off) to start with, else the server decides.
      const wanted = resolveChoice(found.subtitles ?? [], chosen);
      const made = await begin(user, resume ? (found.resumeSeconds ?? 0) : 0, wanted === undefined ? {} : { subtitleIndex: wanted ?? -1 });
      if (!made || gone) return;
      // The track the server picked from the user's subtitle settings (it honours the mode,
      // language and per-show choice).
      const start = wanted === undefined ? made.source.defaultSub : wanted === null || made.source.subs.some((track) => track.index === wanted) ? wanted : made.source.defaultSub;
      live.current.sub = start ?? null;
      setSub(live.current.sub);
      void reportStart(user, { itemId: id, sourceId: made.source.id, playSessionId: made.playSessionId, method: made.method, seconds: resume ? (found.resumeSeconds ?? 0) : 0, paused: false, audioIndex: made.audioIndex, subtitleIndex: live.current.sub });
      void fetchSegments(user, id).then((list) => !gone && setSegs(list));
      void fetchTrickplay(user, id, made.source.id).then((info) => !gone && setTrick(info));
      if (found.type === "Episode") void episodeAfter(user, found).then((after) => !gone && setNext(after)).catch(() => undefined);
    })();
    return () => {
      gone = true;
    };
  }, [id]);

  /// Plays the copy saved on the tablet: no server needed (it is online or not). Where to start is
  /// the later of the tablet's position and the server's last known one; subtitles come from the
  /// cues kept with the file.
  const playSaved = (copy: Saved) => {
    const found = copy.item;
    setItem(found);
    void (async () => {
      const native = await loadNative();
      if (!native || !copy.path) return setError("This saved film can't be found on the tablet.");
      const seconds = resume ? startPosition(copy, found.resumeSeconds) : 0;
      const wanted = resolveChoice(copy.subs, chosen);
      const first = wanted === undefined ? (copy.subs.find((track) => track.isDefault)?.index ?? null) : wanted;
      live.current.sub = first;
      setSub(first);
      const made: Plan = {
        url: native.localFileUrl(copy.path),
        method: "DirectPlay",
        local: true,
        playSessionId: "",
        versions: [],
        source: { id: copy.sourceId ?? copy.id, directPlay: true, audio: [], subs: copy.subs, seconds: found.minutes ? found.minutes * 60 : undefined, container: copy.kind === "converted" ? "mp4 (converted)" : undefined },
      };
      setStart(seconds);
      setActive(made);
      setWaiting(true);
      const after = found.type === "Episode" ? nextSaved(found) : undefined;
      setNext(after?.item ?? null);
    })();
  };

  // Progress every 10 s while playing.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!live.current.paused && live.current.plan) progress();
    }, PROGRESS_MS);
    return () => clearInterval(timer);
  }, [progress]);

  // The OSD hides itself while playing.
  const osdTimer = useRef(0);
  const wake = useCallback(() => {
    setOsd(true);
    setDim(false);
    clearTimeout(osdTimer.current);
    osdTimer.current = window.setTimeout(() => {
      if (!live.current.paused && live.current.scrub === null) setOsd(false);
    }, OSD_MS);
  }, []);
  useEffect(() => () => clearTimeout(osdTimer.current), []);
  useEffect(() => {
    if (paused) {
      setOsd(true);
      const timer = setTimeout(() => setDim(true), DIM_AFTER_MS);
      return () => clearTimeout(timer);
    }
    setDim(false);
    wake();
  }, [paused]);

  // When the OSD appears, focus lands on the play button; when it goes, focus is nowhere (keys
  // are handled by the capture below).
  useEffect(() => {
    if (osd && !menu) {
      if (!root.current?.contains(document.activeElement) || document.activeElement === root.current) focusIfUsable(root.current?.querySelector("[data-play]"));
    } else if (!osd && !menu) {
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [osd, menu]);

  const seekTo = (seconds: number) => {
    const element = video.current;
    if (!element) return;
    element.currentTime = Math.max(0, Math.min(seconds, (live.current.duration || seconds) - 1));
    setTime(element.currentTime);
    setTimeout(progress, 300);
  };

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  };

  const scrubTimer = useRef(0);
  const scrubBy = (direction: -1 | 1, repeat: number) => {
    const base = live.current.scrub ?? live.current.time;
    const target = scrubTarget(base, direction, repeat, live.current.duration);
    live.current.scrub = target;
    setScrub(target);
    wake();
    clearTimeout(scrubTimer.current);
    scrubTimer.current = window.setTimeout(() => {
      live.current.scrub = null;
      setScrub(null);
      seekTo(target);
    }, SCRUB_COMMIT_MS);
  };
  useEffect(() => () => clearTimeout(scrubTimer.current), []);

  const playNext = useCallback(
    (target: Item) => {
      leave(() => advance.current(target.id));
    },
    [leave],
  );

  // What the OK button does when a prompt (Skip Intro, Up next) is showing.
  const segment = activeSegment(segs, time);
  const remaining = duration - time;
  const showNext = !!next && !skippedNext && duration > 120 && remaining <= NEXT_WITHIN && remaining > 0;
  const skip = () => {
    if (!segment) return;
    if (segment.kind === "Outro" && next && !skippedNext && segment.end >= duration - 3) playNext(next);
    else seekTo(segment.end);
  };
  live.current.prompt = showNext ? () => playNext(next!) : segment ? skip : null;

  // Keys: seeking, pausing and the media keys, before the focus engine sees them.
  useEffect(
    () =>
      onKey((event) => {
        const now = live.current;
        if (now.leaving) {
          event.preventDefault();
          return true;
        }
        const code = event.keyCode;
        const take = () => {
          event.preventDefault();
          return true;
        };
        if (code === KEY.play || code === KEY.pause || code === KEY.toggle) {
          if (code === KEY.play && !video.current?.paused) return take();
          if (code === KEY.pause && video.current?.paused) return take();
          toggle();
          return take();
        }
        if (code === KEY.stop) {
          close();
          return take();
        }
        if (code === KEY.forward || code === KEY.rewind) {
          scrubBy(code === KEY.forward ? 1 : -1, event.repeat ? 12 : 0);
          return take();
        }
        if (menuOpen.current) return false;
        const seeking = code === KEY.left || code === KEY.right;
        const onBar = document.activeElement?.hasAttribute("data-seekbar");
        if (!now.osd) {
          if (seeking) {
            scrubBy(code === KEY.left ? -1 : 1, scrubRepeat(event));
            return take();
          }
          if (code === KEY.up || code === KEY.down) {
            wake();
            return take();
          }
          if (code === KEY.ok) {
            if (event.repeat) return take();
            if (now.prompt) now.prompt();
            else toggle();
            return take();
          }
          return false;
        }
        wake();
        if (onBar && seeking) {
          scrubBy(code === KEY.left ? -1 : 1, scrubRepeat(event));
          return take();
        }
        if (onBar && code === KEY.ok) {
          if (!event.repeat) toggle();
          return take();
        }
        return false;
      }),
    [],
  );
  const menuOpen = useRef(false);
  menuOpen.current = menu !== null;
  const repeats = useRef(0);
  const scrubRepeat = (event: KeyboardEvent) => {
    repeats.current = event.repeat ? repeats.current + 1 : 0;
    return repeats.current;
  };

  // The audio track: switch inside the stream when the TV can, else ask the server for the
  // stream again from where we are.
  const chooseAudio = async (index: number) => {
    const now = live.current.plan;
    const user = current.value;
    const element = video.current;
    if (!now || !user || !element || index === now.audioIndex) return;
    const position = now.source.audio.findIndex((track) => track.index === index);
    const tracks = (element as HTMLVideoElement & { audioTracks?: { length: number; [i: number]: { enabled: boolean } } }).audioTracks;
    if (now.method === "DirectPlay" && tracks && tracks.length === now.source.audio.length && position >= 0) {
      for (let i = 0; i < tracks.length; i++) tracks[i]!.enabled = i === position;
      live.current.plan = { ...now, audioIndex: index };
      setActive(live.current.plan);
      progress();
      return;
    }
    await begin(user, live.current.time, { audioIndex: index, subtitleIndex: live.current.sub ?? -1, transcode: now.method === "Transcode" });
  };

  /// Another version of the film, or another quality ceiling: ask the server for the stream again
  /// from where we are. The audio and subtitle choices carry over when the new version has them.
  const restart = async (options: { sourceId?: string; quality?: string }) => {
    const now = live.current.plan;
    const user = current.value;
    if (!now || !user) return;
    flash("Switching");
    const made = await begin(user, live.current.time, { audioIndex: now.audioIndex, subtitleIndex: live.current.sub ?? -1, transcode: now.method === "Transcode", ...options });
    if (made && options.sourceId) {
      const keepsSub = live.current.sub === null || made.source.subs.some((track) => track.index === live.current.sub);
      if (!keepsSub) {
        live.current.sub = made.source.defaultSub ?? null;
        setSub(live.current.sub);
      }
    }
  };

  // Text subtitles: fetch the cues for the chosen track; picture tracks are burned in by the
  // server, and Off draws nothing.
  const sourceId = active?.source.id;
  useEffect(() => {
    const user = current.value;
    const track = live.current.plan?.source.subs.find((entry) => entry.index === sub);
    setCues([]);
    if (!sourceId || !track?.text) return;
    let gone = false;
    const local = live.current.plan?.local;
    if (!local && !user) return;
    (local ? savedCues(id, track.index).then((list) => list ?? Promise.reject(new Error("missing"))) : subtitleCues(user!, id, sourceId, track.index))
      .then((list) => {
        if (gone) return;
        setCues(list);
        if (!list.length) flash("This subtitle track is empty.");
      })
      .catch(() => !gone && flash("Couldn't load the subtitles."));
    return () => {
      gone = true;
    };
  }, [sub, sourceId]);

  const noteTimer = useRef(0);
  const flash = (text: string) => {
    setNote(text);
    clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(""), 4000);
  };
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  /// Picks a subtitle track (null for Off). Drawing a text track needs nothing from the server,
  /// so the film carries on; only burning one in (or taking one out) asks for the stream again.
  const chooseSub = async (index: number | null) => {
    const now = live.current.plan;
    const user = current.value;
    if (!now || !user) return;
    const before = now.source.subs.find((track) => track.index === live.current.sub);
    const after = now.source.subs.find((track) => track.index === index);
    live.current.sub = index;
    setSub(index);
    if (isBurned(before) || isBurned(after)) {
      await begin(user, live.current.time, { audioIndex: now.audioIndex, subtitleIndex: index ?? -1, transcode: now.method === "Transcode" });
    } else {
      progress();
    }
  };

  /// A subtitle was downloaded: ask the server for the film's tracks again and switch to the new one.
  const refreshSubs = async () => {
    const user = current.value;
    const now = live.current.plan;
    if (!user || !now) return;
    const known = new Set(now.source.subs.map((track) => track.index));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fresh = await plan(user, id, { startSeconds: live.current.time, audioIndex: now.audioIndex });
        const added = fresh.source.subs.filter((track) => !known.has(track.index));
        if (added[0]) {
          live.current.plan = { ...now, source: { ...now.source, subs: fresh.source.subs } };
          setActive(live.current.plan);
          await chooseSub(added[0].index);
          return;
        }
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    flash("Downloaded. It can take a moment to show up in the list.");
  };

  const onVideoError = async (fromHls = false) => {
    const user = current.value;
    const now = live.current.plan;
    if (!now || live.current.leaving) return;
    if (now.local) {
      setError("The tablet couldn't play this saved copy. Delete it from Downloads and save it again.");
      return;
    }
    if (!user) return;
    // The tablet's own HLS player failed: try the same stream through hls.js before giving up.
    if (isAndroid && now.method === "Transcode" && !fromHls && !useHls) {
      setUseHls(true);
      return;
    }
    if (now.method === "DirectPlay" && !live.current.retried) {
      live.current.retried = true;
      await begin(user, live.current.time, { audioIndex: now.audioIndex, subtitleIndex: live.current.sub ?? -1, transcode: true });
    } else {
      setError(`The ${isAndroid ? "tablet" : "TV"} couldn't play this. Try another version, or check the server's transcoding.`);
    }
  };

  // Touch: a tap shows or hides the controls; a double tap on the left or right third seeks 10 s
  // that way (more taps add more).
  const taps = useRef({ at: 0, side: 0, timer: 0 });
  useEffect(() => () => clearTimeout(taps.current.timer), []);
  const onTap = (event: MouseEvent) => {
    if (!input.touch || live.current.leaving) return;
    if (event.target !== video.current && event.target !== root.current) return;
    const box = root.current!.getBoundingClientRect();
    const across = (event.clientX - box.left) / box.width;
    const side = across < TAP_SIDE ? -1 : across > 1 - TAP_SIDE ? 1 : 0;
    const last = taps.current;
    const now = Date.now();
    clearTimeout(last.timer);
    if (side !== 0 && side === last.side && now - last.at < TAP_MS) {
      scrubBy(side as -1 | 1, 0);
      taps.current = { at: now, side, timer: 0 };
      return;
    }
    taps.current = {
      at: now,
      side,
      timer: window.setTimeout(() => {
        if (live.current.osd && !live.current.paused) setOsd(false);
        else wake();
      }, TAP_MS),
    };
  };

  // Dragging the bar (finger or pointer): the time follows the finger and the film seeks on release.
  const dragging = useRef(false);
  const dragTime = (event: PointerEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const total = live.current.duration || live.current.plan?.source.seconds || 0;
    return Math.min(Math.max(0, total - 1), Math.max(0, ((event.clientX - box.left) / box.width) * total));
  };
  const dragMove = (event: PointerEvent) => {
    if (!dragging.current) return;
    live.current.scrub = dragTime(event);
    setScrub(live.current.scrub);
    wake();
  };
  const dragEnd = (event: PointerEvent, commit: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    const target = commit ? dragTime(event) : null;
    live.current.scrub = null;
    setScrub(null);
    if (target !== null) seekTo(target);
    wake();
  };

  const closeMenu = () => {
    setMenu(null);
    wake();
  };
  const lines = useActiveLines(video, sub !== null && live.current.plan?.source.subs.find((track) => track.index === sub)?.text ? cues : [], offset);
  const element = video.current;
  const shown = scrub ?? time;
  const total = duration || active?.source.seconds || 0;
  const fraction = total ? Math.min(1, Math.max(0, shown / total)) : 0;
  const thumb = trick && current.value && active ? thumbAt(trick, shown) : null;
  const thumbSrc = thumb && trick && current.value && active ? trickplayUrl(current.value, id, trick, active.source.id, thumb.sheet) : null;
  const title = item?.type === "Episode" ? (item.seriesName ?? item.name) : (item?.name ?? "");
  const subtitle = item?.type === "Episode" ? [episodeCode(item), item.name].filter(Boolean).join(" · ") : "";
  const audioTracks = active?.source.audio ?? [];
  const chapters = item?.chapters ?? [];
  const chapterName = chapters[chapterAt(chapters, shown)]?.name ?? "";
  const info = active && [active.method === "DirectPlay" ? "Direct play" : "Transcoding", isAndroid && active.method === "Transcode" ? (viaHls ? "hls.js" : "native HLS") : "", active.source.container, active.source.video, active.source.audioCodec, active.source.bitrate ? `${(active.source.bitrate / 1e6).toFixed(1)} Mbps` : ""].filter(Boolean);

  return (
    <div ref={root} class={`player${osd || paused ? " has-osd" : ""}${dim ? " is-dim" : ""}`} onMouseMove={input.dpad ? () => !leaving && !live.current.osd && wake() : undefined} onClick={onTap}>
      {active && !leaving && (
        <video
          key={`${active.url}${viaHls}`}
          ref={video}
          class="player-video"
          src={viaHls ? undefined : active.url}
          autoPlay
          playsInline
          onLoadedMetadata={(event) => {
            const v = event.currentTarget;
            setDuration(Number.isFinite(v.duration) ? v.duration : 0);
            if (start > 0) v.currentTime = start;
            v.playbackRate = speed;
          }}
          onPlaying={() => setWaiting(false)}
          onWaiting={() => setWaiting(true)}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onPlay={() => setPaused(false)}
          onPause={() => {
            setPaused(true);
            progress();
          }}
          onSeeked={() => progress()}
          onError={() => void onVideoError(viaHls)}
          onEnded={() => {
            if (live.current.next && autoplay) playNext(live.current.next);
            else close();
          }}
        />
      )}
      <SubtitleView lines={lines} style={subtitleStyle.value} lifted={osd || paused} />
      {(waiting || note) && !error && <div class="player-wait mono secondary">{note || "Loading"}</div>}

      <div class="player-top" hidden={!(osd || paused) || !!error}>
        {input.touch && (
          <div class="row" data-focus-group>
            <Button icon="arrow-left" onPress={close}>
              Back
            </Button>
          </div>
        )}
        <h1 class="section">{title}</h1>
        {subtitle && <p class="secondary">{subtitle}</p>}
        {stats && info && <p class="mono secondary">{info.join("  ·  ")}</p>}
      </div>

      {input.touch && (
        <div class="player-center" hidden={!(osd || paused) || !!error}>
          <Button icon="arrow-counter-clockwise" onPress={() => scrubBy(-1, 0)}>
            10 s
          </Button>
          <button class="button player-toggle" type="button" aria-label={paused ? "Play" : "Pause"} onClick={toggle}>
            <Icon name={paused ? "play" : "pause"} />
          </button>
          <Button icon="arrow-clockwise" onPress={() => scrubBy(1, 0)}>
            10 s
          </Button>
        </div>
      )}

      <div class="player-bottom" hidden={!(osd || paused) || !!error}>
        <div class="row player-buttons" data-focus-group>
          {input.dpad && (
            <>
              <button class="button" type="button" data-focusable data-play tabIndex={-1} onClick={toggle}>
                <Icon name={paused ? "play" : "pause"} />
                {paused ? "Play" : "Pause"}
              </button>
              <Button icon="arrow-counter-clockwise" onPress={() => scrubBy(-1, 0)}>
                10 s
              </Button>
              <Button icon="arrow-clockwise" onPress={() => scrubBy(1, 0)}>
                10 s
              </Button>
            </>
          )}
          {audioTracks.length > 1 && (
            <Button icon="speaker-high" onPress={() => setMenu("audio")}>
              Audio
            </Button>
          )}
          <Button icon={sub !== null ? "check" : "subtitles"} on={sub !== null} onPress={() => setMenu("subs")}>
            {subButtonLabel(active?.source.subs.find((track) => track.index === sub))}
          </Button>
          {(item?.chapters?.length ?? 0) > 1 && (
            <Button icon="list-bullets" onPress={() => setMenu("chapters")}>
              Chapters
            </Button>
          )}
          {!active?.local && (
            <Button icon="sliders-horizontal" onPress={() => setMenu("quality")}>
              Quality
            </Button>
          )}
          {(active?.versions.length ?? 0) > 1 && (
            <Button icon="film-strip" onPress={() => setMenu("version")}>
              Version
            </Button>
          )}
          <Button icon="gauge" onPress={() => setMenu("speed")}>
            {speed === 1 ? "Speed" : `${speed}×`}
          </Button>
          <Button icon={stats ? "check" : "info"} on={stats} onPress={() => setStats(!stats)}>
            Stats
          </Button>
          {next && (
            <Button icon="skip-forward" onPress={() => playNext(next)}>
              Next episode
            </Button>
          )}
        </div>
        <div
          class="seek"
          data-focusable
          data-seekbar
          tabIndex={-1}
          onPointerDown={(event) => {
            if (!total) return;
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            clearTimeout(scrubTimer.current);
            dragMove(event);
          }}
          onPointerMove={dragMove}
          onPointerUp={(event) => dragEnd(event, true)}
          onPointerCancel={(event) => dragEnd(event, false)}
        >
          {thumb && thumbSrc && trick && (
            <div class="seek-thumb" style={{ left: `${fraction * 100}%` }}>
              <div class="seek-picture" style={{ width: `${trick.width}px`, height: `${trick.height}px`, backgroundImage: `url("${thumbSrc}")`, backgroundPosition: `-${thumb.x}px -${thumb.y}px` }} />
            </div>
          )}
          <div class="seek-track">
            <div class="seek-fill" style={{ transform: `scaleX(${fraction})` }} />
            {total > 0 && chapters.slice(1).map((chapter) => <span key={chapter.start} class="seek-mark" style={{ left: `${Math.min(100, (chapter.start / total) * 100)}%` }} />)}
          </div>
        </div>
        <div class="row player-times mono">
          <span>{clock(shown)}</span>
          {chapterName && <span class="secondary player-chapter">{chapterName}</span>}
          <span class="secondary">-{clock(Math.max(0, total - shown))}</span>
        </div>
      </div>

      {!error && (showNext || segment) && (
        <div class="player-prompt row" data-focus-group>
          {showNext && next ? (
            <>
              <div class="prompt-text">
                <p class="secondary">Up next{episodeCode(next) ? `  ·  ${episodeCode(next)}` : ""}</p>
                <p>{next.name}</p>
                <p class="mono secondary">{autoplay ? `Playing in ${Math.ceil(remaining)}` : "Autoplay is off"}</p>
              </div>
              <Button icon="skip-forward" onPress={() => playNext(next)}>
                Play now
              </Button>
              <Button icon="x" onPress={() => setSkippedNext(true)}>
                Stay
              </Button>
            </>
          ) : (
            segment && (
              <Button icon="skip-forward" onPress={skip}>
                {skipLabel(segment.kind)}
              </Button>
            )
          )}
        </div>
      )}

      {error && (
        <div class="player-error">
          <h2 class="section">Can't play this</h2>
          <p class="secondary">{error}</p>
          <div class="row" data-focus-group>
            <Button icon="arrow-left" onPress={close} autoFocus>
              Back
            </Button>
          </div>
        </div>
      )}

      {menu === "audio" && active && (
        <Menu
          title="Audio"
          options={audioTracks.map((track) => ({ id: String(track.index), label: track.label }))}
          value={String(active.audioIndex ?? "")}
          onPick={(value) => void chooseAudio(Number(value))}
          onClose={closeMenu}
        />
      )}
      {menu === "chapters" && (
        <Menu
          title="Chapters"
          options={chapters.map((chapter, position) => ({ id: String(position), label: `${clock(chapter.start)}  ${chapter.name}` }))}
          value={String(Math.max(0, chapterAt(chapters, time)))}
          onPick={(value) => seekTo(chapters[Number(value)]?.start ?? 0)}
          onClose={closeMenu}
        />
      )}
      {menu === "quality" && (
        <Menu
          title="Quality"
          options={QUALITIES.map((entry) => ({ id: entry.id, label: entry.label }))}
          value={quality}
          onPick={(value) => {
            if (value === quality) return;
            setQuality(value);
            live.current.quality = value;
            void restart({ quality: value });
          }}
          onClose={closeMenu}
        />
      )}
      {menu === "version" && active && (
        <Menu
          title="Version"
          options={active.versions.map((entry) => ({ id: entry.id, label: entry.label }))}
          value={active.source.id}
          onPick={(value) => value !== active.source.id && void restart({ sourceId: value })}
          onClose={closeMenu}
        />
      )}
      {menu === "subs" && active && current.value && (
        <SubtitlePanel
          session={current.value}
          itemId={id}
          tracks={active.source.subs}
          selected={sub}
          offset={offset}
          onSelect={(index) => void chooseSub(index)}
          onOffset={(seconds) => {
            setOffset(seconds);
            saveOffset(id, seconds);
          }}
          onAppearance={() => setMenu("style")}
          onDownloaded={refreshSubs}
          onClose={closeMenu}
        />
      )}
      {menu === "style" && <SubtitleStyle onClose={() => setMenu("subs")} />}
      {menu === "speed" && (
        <Menu
          title="Speed"
          options={SPEEDS.map((value) => ({ id: String(value), label: value === 1 ? "Normal" : `${value}×` }))}
          value={String(speed)}
          onPick={(value) => {
            setSpeed(Number(value));
            if (element) element.playbackRate = Number(value);
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
