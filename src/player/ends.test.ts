import { describe, expect, it } from "vitest";
import { endTime, endsLabel } from "./ends";

describe("endTime", () => {
  const now = Date.UTC(2026, 10, 19, 20, 0, 0);
  it("adds what is left", () => {
    expect(endTime(5400, now)?.getTime()).toBe(now + 5400 * 1000);
  });
  it("divides by the playback speed", () => {
    expect(endTime(3600, now, 2)?.getTime()).toBe(now + 1800 * 1000);
  });
  it("is null with nothing left or bad numbers", () => {
    expect(endTime(0, now)).toBeNull();
    expect(endTime(-5, now)).toBeNull();
    expect(endTime(Number.NaN, now)).toBeNull();
    expect(endTime(60, now, 0)).toBeNull();
    expect(endsLabel(0, now)).toBe("");
  });
  it("labels the time", () => {
    expect(endsLabel(60, now)).toMatch(/^Ends \S/);
  });
});
