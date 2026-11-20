import { useEffect, useState } from "preact/hooks";

/// When something with `secondsLeft` to go would end if started at `now`, at `speed`. Null when
/// the numbers make no sense (nothing left, unknown length).
export function endTime(secondsLeft: number, now: number, speed = 1): Date | null {
  if (!Number.isFinite(secondsLeft) || secondsLeft <= 0 || !Number.isFinite(speed) || speed <= 0) return null;
  return new Date(now + (secondsLeft / speed) * 1000);
}

/// "Ends 9:42 PM" (or "Ends 21:42", by the device's locale), or "" when there is no end to show.
export function endsLabel(secondsLeft: number, now: number, speed = 1): string {
  const end = endTime(secondsLeft, now, speed);
  return end ? `Ends ${end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
}

/// The current time, refreshed every `everyMs` while `on`, so an end time keeps moving while a
/// film sits paused or a detail page stays open.
export function useNow(on: boolean, everyMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [on, everyMs]);
  return now;
}
