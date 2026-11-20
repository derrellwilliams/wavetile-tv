import type { ComponentChildren } from "preact";
import { artSrc, facts, type Item } from "../../api/items";
import { Icon } from "../../design/components/Icon";
import { token } from "../../design/tokens";
import { endsLabel, useNow } from "../../player/ends";
import type { SeenMark } from "../../letterboxd/marks";

interface Props {
  item: Item;
  /// The detail page shows genres and a longer description.
  full?: boolean;
  /// A line above the title ("Continue watching", a show's name).
  kicker?: string;
  /// The viewer's own history with it (rating, last watched, watchlist), as icons with short text.
  seen?: SeenMark[];
  /// Letterboxd's average, shown beside the rating.
  average?: number | null;
  children?: ComponentChildren;
}

/// Backdrop, logo (or the title in type), facts, description and a row of buttons: Home's
/// spotlight and the head of every detail page.
export function Hero({ item, full, kicker, seen, average, children }: Props) {
  const backdrop = artSrc(item.backdrop, token("--backdrop-w"), token("--backdrop-h"), false);
  const logo = artSrc(item.logo, token("--logo-w"), token("--logo-h"), false);
  const line = facts(item, average);
  // The detail page of a film or episode says when it would end if started (or resumed) now.
  const timed = !!full && (item.type === "Movie" || item.type === "Episode") && !!item.minutes;
  const now = useNow(timed, 60_000);
  const ends = timed && item.minutes ? endsLabel(item.minutes * 60 - (item.resumeSeconds ?? 0), now) : "";
  if (ends) line.push(ends);
  // An episode is headed by its show (whose logo this is), with its own name on the next line.
  const heading = item.type === "Episode" ? (item.seriesName ?? item.name) : item.name;

  return (
    <header class="hero" data-scroll-anchor>
      {backdrop && (
        <img
          key={backdrop}
          class="art hero-art"
          src={backdrop}
          alt=""
          decoding="async"
          onLoad={(event) => event.currentTarget.classList.add("is-loaded")}
        />
      )}
      <div class="hero-body">
        {kicker && <p class="secondary">{kicker}</p>}
        {logo ? <img key={logo} class="hero-logo" src={logo} alt={heading} /> : <h1 class="display">{heading}</h1>}
        {heading !== item.name && <p class="section">{item.name}</p>}
        {line.length > 0 && <p class="mono secondary">{line.join("  ·  ")}</p>}
        {seen && seen.length > 0 && (
          <p class="mono hero-seen">
            {seen.map((mark) => (
              <span key={mark.icon} class="hero-mark" aria-label={mark.label}>
                <Icon name={mark.icon} />
                {mark.text}
              </span>
            ))}
          </p>
        )}
        {full && item.genres.length > 0 && <p class="secondary">{item.genres.slice(0, 4).join(", ")}</p>}
        {item.overview && <p class={full ? "hero-overview" : "hero-overview is-short"}>{item.overview}</p>}
        {children && (
          <div class="row hero-actions" data-focus-group>
            {children}
          </div>
        )}
      </div>
    </header>
  );
}
