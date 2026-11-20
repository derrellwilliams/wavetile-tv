/// What the app keeps of a Jellyfin item. Everything the server sends is checked here, once:
/// IDs and image tags go into URLs, so they must look like IDs; text is cut to a sane length (and
/// is only ever rendered as text); numbers are range-checked. The rest of the app and the cache
/// only ever see an `Item`.
import type { BaseItemDto, UserItemDataDto } from "@jellyfin/sdk/lib/generated-client/models";
import { input } from "../platform/platform";
import { toChapters, type Chapter } from "../player/chapters";
import { toSubTracks, type SubTrack } from "../subtitles/tracks";
import { session } from "./session";

export type ItemType = "Movie" | "Series" | "Season" | "Episode" | "BoxSet" | "Person";
const TYPES: readonly string[] = ["Movie", "Series", "Season", "Episode", "BoxSet", "Person"];

/// One image on the server: which item holds it, which kind, and the tag that names its version.
export interface Art {
  id: string;
  kind: "Primary" | "Backdrop" | "Thumb" | "Logo";
  tag: string;
}

export interface Person {
  id: string;
  name: string;
  role: string;
  art?: Art;
}

export interface Item {
  id: string;
  type: ItemType;
  name: string;
  sortName: string;
  year?: number;
  endYear?: number;
  /// Series only: still running.
  continuing?: boolean;
  minutes?: number;
  /// Community rating, 0 to 10.
  rating?: number;
  /// Critic rating, 0 to 100.
  critic?: number;
  certificate?: string;
  overview?: string;
  genres: string[];
  /// When it was added to the library, ms since 1970.
  added?: number;
  played: boolean;
  favorite: boolean;
  /// How far through, 0 to 1, when partly watched.
  progress?: number;
  /// Where to resume, in seconds, when partly watched.
  resumeSeconds?: number;
  /// Series and seasons: episodes not yet watched.
  unplayed?: number;
  seriesId?: string;
  seriesName?: string;
  seasonId?: string;
  season?: number;
  episode?: number;
  tmdb?: string;
  poster?: Art;
  /// Landscape image for wide cards.
  thumb?: Art;
  backdrop?: Art;
  logo?: Art;
  people?: Person[];
  /// The subtitle tracks of its first version (detail pages only).
  subtitles?: SubTrack[];
  /// Chapter marks (detail pages only).
  chapters?: Chapter[];
}

const MAX_NAME = 200;
const MAX_OVERVIEW = 2000;
const MAX_LIST = 40;

function id(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f-]{32,36}$/i.test(value) ? value : undefined;
}

function tag(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function number(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function date(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

function art(owner: unknown, kind: Art["kind"], imageTag: unknown): Art | undefined {
  const ownerId = id(owner);
  const checked = tag(imageTag);
  return ownerId && checked ? { id: ownerId, kind, tag: checked } : undefined;
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}

/// An `Item` from what the server sent, or null when it isn't something the app shows.
export function toItem(value: unknown): Item | null {
  if (!value || typeof value !== "object") return null;
  const dto = value as BaseItemDto;
  const itemId = id(dto.Id);
  const name = text(dto.Name, MAX_NAME);
  if (!itemId || !name || typeof dto.Type !== "string" || !TYPES.includes(dto.Type)) return null;
  const type = dto.Type as ItemType;
  const images = dto.ImageTags && typeof dto.ImageTags === "object" ? dto.ImageTags : {};
  const user: Partial<UserItemDataDto> = dto.UserData && typeof dto.UserData === "object" ? dto.UserData : {};
  const seriesId = id(dto.SeriesId);

  const own = art(itemId, "Primary", images.Primary);
  const backdrop =
    art(itemId, "Backdrop", first(dto.BackdropImageTags)) ??
    art(dto.ParentBackdropItemId, "Backdrop", first(dto.ParentBackdropImageTags));
  const ticks = number(dto.RunTimeTicks, 1, 1e15);
  const position = number(user.PlaybackPositionTicks, 1, 1e15);
  const percent = number(user.PlayedPercentage, 0, 100);
  const progress = percent !== undefined ? percent / 100 : ticks && position ? Math.min(1, position / ticks) : undefined;
  const source = first(dto.MediaSources) as { MediaStreams?: unknown } | undefined;
  const subtitles = toSubTracks(source?.MediaStreams);
  const chapters = toChapters(dto.Chapters);
  const end = date(dto.EndDate);
  const tmdb = dto.ProviderIds && typeof dto.ProviderIds === "object" ? dto.ProviderIds.Tmdb : undefined;

  const people: Person[] = [];
  if (Array.isArray(dto.People)) {
    for (const entry of dto.People.slice(0, MAX_LIST)) {
      const personId = id(entry?.Id);
      const personName = text(entry?.Name, MAX_NAME);
      if (!personId || !personName || people.some((person) => person.id === personId)) continue;
      const kind = typeof entry.Type === "string" && entry.Type !== "Actor" ? entry.Type.slice(0, 40) : "";
      people.push({
        id: personId,
        name: personName,
        role: text(entry.Role, MAX_NAME) ?? kind,
        art: art(personId, "Primary", entry.PrimaryImageTag),
      });
    }
  }

  return {
    id: itemId,
    type,
    name,
    sortName: (text(dto.SortName, MAX_NAME) ?? name).toLowerCase(),
    year: number(dto.ProductionYear, 1870, 2200),
    endYear: end === undefined ? undefined : new Date(end).getUTCFullYear(),
    continuing: type === "Series" && dto.Status === "Continuing" ? true : undefined,
    minutes: ticks ? Math.max(1, Math.round(ticks / 600_000_000)) : undefined,
    rating: number(dto.CommunityRating, 0, 10),
    critic: number(dto.CriticRating, 0, 100),
    certificate: text(dto.OfficialRating, 20),
    overview: text(dto.Overview, MAX_OVERVIEW),
    genres: Array.isArray(dto.Genres)
      ? dto.Genres.map((genre) => text(genre, 60)).filter((genre): genre is string => !!genre).slice(0, MAX_LIST)
      : [],
    added: date(dto.DateCreated),
    played: user.Played === true,
    favorite: user.IsFavorite === true,
    progress: progress && progress > 0 && progress < 1 ? progress : undefined,
    resumeSeconds: progress && progress > 0 && progress < 1 && position ? Math.round(position / 10_000_000) : undefined,
    unplayed: number(user.UnplayedItemCount, 1, 100_000),
    seriesId,
    seriesName: text(dto.SeriesName, MAX_NAME),
    seasonId: id(dto.SeasonId),
    season: number(dto.ParentIndexNumber, 0, 10_000),
    episode: number(dto.IndexNumber, 0, 100_000),
    tmdb: typeof tmdb === "string" && /^\d{1,10}$/.test(tmdb) ? tmdb : undefined,
    // An episode's own picture is a still from it; its poster is the show's.
    poster: type === "Episode" ? (art(seriesId, "Primary", dto.SeriesPrimaryImageTag) ?? undefined) : own,
    thumb:
      type === "Episode"
        ? (own ?? backdrop)
        : (art(itemId, "Thumb", images.Thumb) ?? backdrop ?? art(dto.ParentThumbItemId, "Thumb", dto.ParentThumbImageTag)),
    backdrop,
    logo: art(itemId, "Logo", images.Logo) ?? art(dto.ParentLogoItemId, "Logo", dto.ParentLogoImageTag),
    people: people.length ? people : undefined,
    subtitles: subtitles.length ? subtitles : undefined,
    chapters: chapters.length ? chapters : undefined,
  };
}

/// Items from a list reply: either `{ Items: [...] }` or a bare array. Anything unusable is dropped.
export function toItems(reply: unknown): Item[] {
  const list = Array.isArray(reply) ? reply : (reply as { Items?: unknown } | null)?.Items;
  if (!Array.isArray(list)) return [];
  const items: Item[] = [];
  for (const entry of list) {
    const item = toItem(entry);
    if (item) items.push(item);
  }
  return items;
}

/// Address of an image at the size it will be shown. `crop` fills the box exactly (posters,
/// thumbnails); otherwise the image is fitted inside it (logos). Images need no token.
export function artUrl(server: string, image: Art, width: number, height: number, crop = true, light = false): string {
  const size = crop ? `fillWidth=${width}&fillHeight=${height}` : `maxWidth=${width}&maxHeight=${height}`;
  // `light` (the tablet): WebP at a lower quality, a smaller file for a weak chip and Wi-Fi.
  const look = light ? "format=Webp&quality=80" : "quality=90";
  return `${server}/Items/${image.id}/Images/${image.kind}?${size}&${look}&tag=${image.tag}`;
}

/// Requested size for a slot of `css` pixels: the tablet's screen has more device pixels than
/// CSS pixels (1.33 on the Fire HD 8), capped at 2 so a sharper screen doesn't mean bigger files.
export function imagePixels(css: number, ratio: number, touch: boolean): number {
  return Math.round(touch ? css * Math.min(2, Math.max(1, ratio)) : css);
}

/// The same, for the signed-in server. Null when there is no image or no session.
export function artSrc(image: Art | undefined, width: number, height: number, crop = true): string | null {
  const server = session.value?.server;
  if (!image || !server) return null;
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return artUrl(server, image, imagePixels(width, ratio, input.touch), imagePixels(height, ratio, input.touch), crop, input.touch);
}

/// "2h 12m", "48m".
export function runtime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? (rest ? `${hours}h ${rest}m` : `${hours}h`) : `${rest}m`;
}

/// "S2 E5", or just "E5" / "" when the numbers are missing.
export function episodeCode(item: Item): string {
  const parts: string[] = [];
  if (item.season !== undefined) parts.push(`S${item.season}`);
  if (item.episode !== undefined) parts.push(`E${item.episode}`);
  return parts.join(" ");
}

/// "2019", "2019 – 2023", "2019 – now".
export function years(item: Item): string {
  if (item.year === undefined) return "";
  if (item.type !== "Series") return String(item.year);
  if (item.continuing) return `${item.year} – now`;
  return item.endYear && item.endYear !== item.year ? `${item.year} – ${item.endYear}` : String(item.year);
}

/// The mono line of facts under a title: years, runtime, certificate, rating. A Letterboxd average
/// (0.5 to 5) goes next to the rating: "8.2/10 • 4.2".
export function facts(item: Item, average?: number | null): string[] {
  const list: string[] = [];
  if (item.type === "Episode" && episodeCode(item)) list.push(episodeCode(item));
  if (years(item)) list.push(years(item));
  if (item.minutes && item.type !== "Series") list.push(runtime(item.minutes));
  if (item.certificate) list.push(item.certificate);
  // One public score: Letterboxd's average (out of 5) when it is known, else the server's (out of 10).
  if (average) list.push(`${average.toFixed(1)}/5`);
  else if (item.rating) list.push(`${item.rating.toFixed(1)}/10`);
  return list;
}

/// Title and second line for a card, by what the card is showing.
export function cardText(item: Item): { title: string; detail: string } {
  if (item.type === "Episode") {
    const code = episodeCode(item);
    return { title: item.seriesName ?? item.name, detail: code ? `${code} · ${item.name}` : item.name };
  }
  if (item.type === "Series" && item.unplayed) return { title: item.name, detail: `${item.unplayed} to watch` };
  return { title: item.name, detail: years(item) };
}
