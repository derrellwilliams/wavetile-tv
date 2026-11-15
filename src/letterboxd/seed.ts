/// An export baked into this build (see `npm run seed`), used for the owner's own TV so no upload
/// is needed. The data file is git-ignored; without it this does nothing. It loads once per
/// different export, so choosing "Forget Letterboxd data" stays forgotten until a newer one is built in.
import { load, save } from "../api/storage";
import { buildLog, type Files } from "./log";
import { setWatchLog } from "./store";
import { isUsername, setUsername, username } from "./feed";

const modules = import.meta.glob<{ seed: Files & { user?: string } }>("./seed.local.ts", { eager: true });
const FLAG = "letterboxd.seeded";
const USER_FLAG = "letterboxd.seeded.user";

export function applySeed(): void {
  const seed = Object.values(modules)[0]?.seed;
  if (!seed) return;
  // The export's account fills in the feed username once, so recent watches show up with no typing.
  // Clearing or changing it in Settings sticks.
  if (seed.user && isUsername(seed.user) && load(USER_FLAG) !== seed.user) {
    if (!username.value) setUsername(seed.user);
    save(USER_FLAG, seed.user);
  }
  const stamp = `${seed.watched?.length}:${seed.ratings?.length}:${seed.diary?.length}:${seed.watchlist?.length}`;
  if (load(FLAG) === stamp) return;
  const films = buildLog(seed);
  if (films.length) setWatchLog(films);
  save(FLAG, stamp);
}
