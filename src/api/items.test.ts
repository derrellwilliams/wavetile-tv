import { describe, expect, it } from "vitest";
import { artUrl, cardText, episodeCode, facts, imagePixels, runtime, toItem, toItems, years } from "./items";

const ID = "0123456789abcdef0123456789abcdef";
const SERIES = "fedcba9876543210fedcba9876543210";

describe("toItem", () => {
  it("keeps what the app shows from a movie", () => {
    const item = toItem({
      Id: ID,
      Type: "Movie",
      Name: "  Heat ",
      SortName: "Heat",
      ProductionYear: 1995,
      RunTimeTicks: 170 * 600_000_000,
      CommunityRating: 8.3,
      OfficialRating: "R",
      Genres: ["Crime", "", 5, "Drama"],
      DateCreated: "2024-01-02T03:04:05.0000000Z",
      ProviderIds: { Tmdb: "949", Imdb: "tt0113277" },
      ImageTags: { Primary: "aaa", Logo: "bbb" },
      BackdropImageTags: ["ccc"],
      UserData: { Played: true, IsFavorite: false, PlaybackPositionTicks: 0 },
    });
    expect(item).toMatchObject({
      id: ID,
      type: "Movie",
      name: "Heat",
      sortName: "heat",
      year: 1995,
      minutes: 170,
      rating: 8.3,
      certificate: "R",
      genres: ["Crime", "Drama"],
      tmdb: "949",
      played: true,
      favorite: false,
      poster: { id: ID, kind: "Primary", tag: "aaa" },
      backdrop: { id: ID, kind: "Backdrop", tag: "ccc" },
      thumb: { id: ID, kind: "Backdrop", tag: "ccc" },
      logo: { id: ID, kind: "Logo", tag: "bbb" },
    });
    expect(item?.added).toBe(Date.parse("2024-01-02T03:04:05Z"));
    expect(item?.progress).toBeUndefined();
  });

  it("gives an episode its show's poster, backdrop and logo, and its own still", () => {
    const item = toItem({
      Id: ID,
      Type: "Episode",
      Name: "Pilot",
      SeriesId: SERIES,
      SeriesName: "The Show",
      SeriesPrimaryImageTag: "ser",
      ParentBackdropItemId: SERIES,
      ParentBackdropImageTags: ["back"],
      ParentLogoItemId: SERIES,
      ParentLogoImageTag: "logo",
      ImageTags: { Primary: "still" },
      ParentIndexNumber: 1,
      IndexNumber: 3,
      RunTimeTicks: 1000,
      UserData: { PlaybackPositionTicks: 250 },
    });
    expect(item).toMatchObject({
      poster: { id: SERIES, kind: "Primary", tag: "ser" },
      thumb: { id: ID, kind: "Primary", tag: "still" },
      backdrop: { id: SERIES, kind: "Backdrop", tag: "back" },
      logo: { id: SERIES, kind: "Logo", tag: "logo" },
      season: 1,
      episode: 3,
      progress: 0.25,
    });
    expect(cardText(item!)).toEqual({ title: "The Show", detail: "S1 E3 · Pilot" });
  });

  it("refuses items without a usable ID, name or type", () => {
    expect(toItem(null)).toBeNull();
    expect(toItem("x")).toBeNull();
    expect(toItem({ Id: "../../System", Type: "Movie", Name: "x" })).toBeNull();
    expect(toItem({ Id: ID, Type: "Movie", Name: "   " })).toBeNull();
    expect(toItem({ Id: ID, Type: "Audio", Name: "Song" })).toBeNull();
  });

  it("drops image tags and IDs that could change the URL they go into", () => {
    const item = toItem({
      Id: ID,
      Type: "Movie",
      Name: "x",
      ImageTags: { Primary: "a&api_key=1", Thumb: "ok-1" },
      BackdropImageTags: ["../x"],
      ParentBackdropItemId: "evil/path",
      ParentBackdropImageTags: ["fine"],
      ProviderIds: { Tmdb: "12?x=1" },
    });
    expect(item?.poster).toBeUndefined();
    expect(item?.backdrop).toBeUndefined();
    expect(item?.thumb).toEqual({ id: ID, kind: "Thumb", tag: "ok-1" });
    expect(item?.tmdb).toBeUndefined();
  });

  it("range-checks numbers and cuts long text", () => {
    const item = toItem({
      Id: ID,
      Type: "Movie",
      Name: "n".repeat(900),
      Overview: "o".repeat(9000),
      ProductionYear: 99999,
      CommunityRating: "9",
      CriticRating: 250,
      RunTimeTicks: -5,
      DateCreated: "not a date",
      UserData: { PlayedPercentage: 400, UnplayedItemCount: -3 },
    });
    expect(item?.name).toHaveLength(200);
    expect(item?.overview).toHaveLength(2000);
    expect(item).toMatchObject({ genres: [], played: false, favorite: false });
    for (const key of ["year", "rating", "critic", "minutes", "added", "progress", "unplayed"] as const) {
      expect(item?.[key]).toBeUndefined();
    }
  });

  it("lists each person once, with a role or their job", () => {
    const item = toItem({
      Id: ID,
      Type: "Movie",
      Name: "x",
      People: [
        { Id: SERIES, Name: "Al", Role: "Vincent", Type: "Actor", PrimaryImageTag: "p1" },
        { Id: SERIES, Name: "Al", Role: "Again", Type: "Actor" },
        { Id: ID, Name: "Michael", Type: "Director" },
        { Id: "nope", Name: "Bad" },
      ],
    });
    expect(item?.people).toEqual([
      { id: SERIES, name: "Al", role: "Vincent", art: { id: SERIES, kind: "Primary", tag: "p1" } },
      { id: ID, name: "Michael", role: "Director", art: undefined },
    ]);
  });
});

describe("toItems", () => {
  it("reads both reply shapes and drops unusable entries", () => {
    const good = { Id: ID, Type: "Series", Name: "Show" };
    expect(toItems({ Items: [good, { Id: 5 }, null] })).toHaveLength(1);
    expect(toItems([good, good])).toHaveLength(2);
    expect(toItems({ Items: "no" })).toEqual([]);
    expect(toItems(undefined)).toEqual([]);
  });
});

describe("artUrl", () => {
  const art = { id: ID, kind: "Primary", tag: "abc" } as const;
  it("asks for the size shown, cropped or fitted, and carries no token", () => {
    expect(artUrl("http://nas:8096", art, 222, 333)).toBe(
      `http://nas:8096/Items/${ID}/Images/Primary?fillWidth=222&fillHeight=333&quality=90&tag=abc`,
    );
    expect(artUrl("http://nas:8096", art, 560, 180, false)).toContain("maxWidth=560&maxHeight=180");
  });
});

describe("text for cards and headers", () => {
  const base = { id: ID, name: "Name", sortName: "name", genres: [], played: false, favorite: false };

  it("formats runtimes", () => {
    expect(runtime(48)).toBe("48m");
    expect(runtime(120)).toBe("2h");
    expect(runtime(132)).toBe("2h 12m");
  });

  it("formats years for movies and for finished and running shows", () => {
    expect(years({ ...base, type: "Movie", year: 1999, endYear: 2001 })).toBe("1999");
    expect(years({ ...base, type: "Series", year: 2019, endYear: 2023 })).toBe("2019 – 2023");
    expect(years({ ...base, type: "Series", year: 2019, continuing: true })).toBe("2019 – now");
    expect(years({ ...base, type: "Series", year: 2019, endYear: 2019 })).toBe("2019");
    expect(years({ ...base, type: "Movie" })).toBe("");
  });

  it("builds the facts line from what is known", () => {
    expect(facts({ ...base, type: "Movie", year: 1995, minutes: 170, certificate: "R", rating: 8.25 })).toEqual([
      "1995",
      "2h 50m",
      "R",
      "8.3/10",
    ]);
    expect(facts({ ...base, type: "Movie", rating: 8.2 }, 4.21)).toEqual(["4.2/5"]);
    expect(facts({ ...base, type: "Movie" }, 4.21)).toEqual(["4.2/5"]);
    expect(facts({ ...base, type: "Series", minutes: 50 })).toEqual([]);
  });

  it("writes episode codes with whatever numbers exist", () => {
    expect(episodeCode({ ...base, type: "Episode", season: 2, episode: 5 })).toBe("S2 E5");
    expect(episodeCode({ ...base, type: "Episode", episode: 5 })).toBe("E5");
    expect(episodeCode({ ...base, type: "Episode" })).toBe("");
  });

  it("shows what is left to watch on a show's card", () => {
    expect(cardText({ ...base, type: "Series", year: 2020, unplayed: 4 })).toEqual({ title: "Name", detail: "4 to watch" });
    expect(cardText({ ...base, type: "Movie", year: 2020 })).toEqual({ title: "Name", detail: "2020" });
  });
});

describe("tablet image requests", () => {
  const art = { id: "a".repeat(32), kind: "Primary" as const, tag: "b".repeat(32) };
  it("asks for WebP at a lighter quality when light", () => {
    const url = artUrl("http://nas:8096", art, 160, 240, true, true);
    expect(url).toContain("format=Webp&quality=80");
    expect(url).not.toContain("quality=90");
  });
  it("leaves the TV's request as it was", () => {
    expect(artUrl("http://nas:8096", art, 160, 240)).toContain("quality=90");
  });
  it("sizes for the screen's pixels on the tablet only, capped at 2x", () => {
    expect(imagePixels(160, 1.33, true)).toBe(213);
    expect(imagePixels(160, 3, true)).toBe(320);
    expect(imagePixels(160, 0.5, true)).toBe(160);
    expect(imagePixels(160, 1.33, false)).toBe(160);
  });
});
