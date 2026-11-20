import { useEffect, useRef } from "preact/hooks";
import { artSrc, type Art } from "../../api/items";
import { Button } from "../../design/components/Button";
import { token } from "../../design/tokens";
import { onEdge, pushScope } from "../../nav/focus";
import { useBack } from "../../nav/hooks";
import { cycle, DEFAULT_STYLE, labelFor, LABELS, OPTIONS, setStyle, subtitleStyle, type StyleKey } from "../../subtitles/style";
import { toLines } from "../../subtitles/cues";
import { SubtitleView } from "./SubtitleView";

const SAMPLE = toLines("The quick brown fox<br><i>jumps over the lazy dog.</i>");

/// Subtitle appearance with a live preview. Each button moves one choice to the next option.
/// Used from the player (over the film) and from Account. `picture` (the film's backdrop) goes
/// behind the sample so the text is judged against a real frame; without it the stage is plain.
export function SubtitleStyle({ onClose, picture }: { onClose: () => void; picture?: Art }) {
  // The same size the detail page asks for, so the picture usually comes from the cache.
  const src = artSrc(picture, token("--backdrop-w"), token("--backdrop-h"), false);
  const page = useRef<HTMLDivElement>(null);
  const style = subtitleStyle.value;
  useBack(onClose);
  useEffect(() => (page.current ? pushScope(page.current) : undefined), []);
  useEffect(() => onEdge(() => true), []);

  return (
    <div ref={page} class="sub-editor">
      <h1 class="display sub-editor-title">Subtitle appearance</h1>
      <div class="sub-editor-controls">
        <div class="sub-options" data-focus-group>
          {(Object.keys(OPTIONS) as StyleKey[]).map((key, n) => (
            <Button key={key} autoFocus={n === 0} onPress={() => setStyle(cycle(subtitleStyle.value, key))}>
              {LABELS[key]}
              <span class="mono secondary">{labelFor(style, key)}</span>
            </Button>
          ))}
        </div>
        <div class="row sub-editor-actions" data-focus-group>
          <Button icon="arrow-counter-clockwise" onPress={() => setStyle(DEFAULT_STYLE)}>
            Reset
          </Button>
          <Button icon="check" onPress={onClose}>
            Done
          </Button>
        </div>
      </div>
      <div class="sub-stage">
        {src && <img class="art sub-stage-art" src={src} alt="" decoding="async" onLoad={(event) => event.currentTarget.classList.add("is-loaded")} />}
        <div class="sub-stage-inner">
          <SubtitleView lines={SAMPLE} style={style} />
        </div>
      </div>
    </div>
  );
}
