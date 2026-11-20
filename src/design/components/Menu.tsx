import { Drawer } from "./Drawer";
import { Icon } from "./Icon";

export interface Option {
  id: string;
  label: string;
}

interface Props {
  title: string;
  options: Option[];
  value: string;
  onPick: (id: string) => void;
  onClose: () => void;
  /// What Back does when it isn't "close" (back to the sheet this menu was opened from).
  onBack?: () => void;
}

/// A drawer with one list to choose from (sort order, genre). OK picks and closes, Back closes.
export function Menu({ title, options, value, onPick, onClose, onBack }: Props) {
  return (
    <Drawer title={title} onClose={onClose} onBack={onBack}>
      <div class="drawer-list" data-scroll="y" data-focus-group>
        {options.map((option) => (
          <button
            key={option.id}
            class="button drawer-option"
            type="button"
            data-focusable
            data-autofocus={option.id === value || undefined}
            tabIndex={-1}
            onClick={() => {
              onPick(option.id);
              onClose();
            }}
          >
            <span class="drawer-label">{option.label}</span>
            {option.id === value && <Icon name="check" />}
          </button>
        ))}
      </div>
    </Drawer>
  );
}
