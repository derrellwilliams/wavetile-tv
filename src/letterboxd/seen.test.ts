import { describe, expect, it } from "vitest";
import { seenMarks, shortDate } from "./marks";

describe("seen marks", () => {
  it("writes short dates, with the year only when it isn't this one", () => {
    expect(shortDate("2026-10-31", 2026)).toBe("Oct 31");
    expect(shortDate("2024-03-05", 2026)).toBe("Mar 5, 2024");
    expect(shortDate("odd", 2026)).toBe("odd");
  });

  it("lists rating, last watch, rewatches and the watchlist", () => {
    expect(seenMarks(undefined)).toEqual([]);
    expect(seenMarks({ watched: true, rating: 4, last: "2026-10-31", rewatches: 2, watchlist: false }, 2026).map((mark) => mark.text)).toEqual(["4", "Oct 31", "2×"]);
    expect(seenMarks({ watched: false, rewatches: 0, watchlist: true }, 2026).map((mark) => mark.icon)).toEqual(["bookmark-simple"]);
  });
});
