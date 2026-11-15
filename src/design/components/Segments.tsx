import type { IconName } from "../icons.gen";
import { Button } from "./Button";

export interface Segment<T extends string> {
  id: T;
  label: string;
  icon: IconName;
}

interface Props<T extends string> {
  label: string;
  options: readonly Segment<T>[];
  value: T;
  onPick: (id: T) => void;
}

/// A choice of one, every option in view (Unwatched / Watched). The chosen one is a raised chip
/// whose icon turns into a check, so it still reads as chosen while the remote's focus fill is on it.
/// Every option keeps an icon, so choosing never changes the row's width.
export function Segments<T extends string>({ label, options, value, onPick }: Props<T>) {
  return (
    <div class="segments" role="group" aria-label={label}>
      {options.map((option) => (
        <Button key={option.id} icon={option.id === value ? "check" : option.icon} on={option.id === value} onPress={() => onPick(option.id)}>
          {option.label}
        </Button>
      ))}
    </div>
  );
}
