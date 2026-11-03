import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type AriaAttributes,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export type SelectOption = { value: string; label: string; disabled?: boolean };
type Props = AriaAttributes & {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
};

// Popup focus stays on its owning button, including inside a modal. This keeps
// nested dialogs' focus traps and terminal keyboard shortcuts predictable.
export function Select({
  id: supplied,
  value,
  options,
  onChange,
  disabled,
  placeholder = "请选择",
  className = "",
  ...aria
}: Props) {
  const generated = useId(),
    id = supplied || `select-${generated}`;
  const button = useRef<HTMLButtonElement>(null),
    popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(-1);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 280,
    up: false,
  });
  const search = useRef({ text: "", at: 0 });
  const selected = options.findIndex((o) => o.value === value);
  const show = () => {
    if (!disabled) {
      setActive(
        selected >= 0 && !options[selected]?.disabled
          ? selected
          : options.findIndex((o) => !o.disabled),
      );
      setOpen(true);
    }
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    button.current?.focus({ preventScroll: true });
    onChange(option.value);
  };
  useLayoutEffect(() => {
    if (!open || disabled) {
      if (disabled) setOpen(false);
      return;
    }
    const place = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 8 || rect.top > innerHeight - 8) {
        setOpen(false);
        return;
      }
      const below = innerHeight - rect.bottom - 12,
        above = rect.top - 12;
      const up = below < 180 && above > below;
      const height = Math.max(40, Math.min(280, up ? above : below));
      const width = Math.min(Math.max(rect.width, 150), innerWidth - 16);
      setPosition({
        left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)),
        top: up ? rect.top - 6 : rect.bottom + 6,
        width,
        height,
        up,
      });
    };
    const outside = (event: PointerEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !popup.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    place();
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    const scroll = (event: Event) => {
      if (!popup.current?.contains(event.target as Node)) place();
    };
    document.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, disabled]);
  useLayoutEffect(() => {
    if (open)
      popup.current
        ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  const move = (step: number) => {
    let next = active;
    for (let n = 0; n < options.length; n++) {
      next = (next + step + options.length) % options.length;
      if (!options[next].disabled) {
        setActive(next);
        return;
      }
    }
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (
      ["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!open) {
        show();
        return;
      }
      if (event.key === "Enter" || event.key === " ") choose(active);
      else if (event.key === "Home")
        setActive(options.findIndex((o) => !o.disabled));
      else if (event.key === "End") {
        for (let i = options.length - 1; i >= 0; i--)
          if (!options[i].disabled) {
            setActive(i);
            break;
          }
      } else move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      const text =
        performance.now() - search.current.at > 700
          ? event.key
          : search.current.text + event.key;
      search.current = { text, at: performance.now() };
      if (!open) show();
      const index = options.findIndex(
        (o) =>
          !o.disabled &&
          o.label.toLocaleLowerCase().startsWith(text.toLocaleLowerCase()),
      );
      if (index >= 0) setActive(index);
    }
  };
  const host =
    typeof document !== "undefined"
      ? document.fullscreenElement || document.body
      : null;
  return (
    <>
      <button
        {...aria}
        ref={button}
        id={id}
        data-value={value}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${id}-option-${active}` : undefined
        }
        disabled={disabled}
        className={`theme-select ${open ? "is-open" : ""} ${className}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keyboard}
      >
        <span>{options[selected]?.label || placeholder}</span>
        <ChevronDown size={15} />
      </button>
      {open &&
        host &&
        createPortal(
          <div
            ref={popup}
            id={`${id}-list`}
            role="listbox"
            aria-label={aria["aria-label"] || "可选项"}
            className="theme-select-popup"
            data-select-owner={id}
            style={{
              left: position.left,
              top: position.top,
              width: position.width,
              maxHeight: position.height,
              transform: position.up ? "translateY(-100%)" : undefined,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((option, index) => (
              <div
                id={`${id}-option-${index}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={`theme-select-option ${index === active ? "highlighted" : ""}`}
                data-index={index}
                data-value={option.value}
                onPointerMove={() => {
                  if (!option.disabled) setActive(index);
                }}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={14} />}
              </div>
            ))}
            {!options.length && (
              <div className="theme-select-empty">暂无选项</div>
            )}
          </div>,
          host,
        )}
    </>
  );
}

export function ownsSelectPopup(
  target: EventTarget | null,
  owner: HTMLElement | null,
) {
  if (!(target instanceof Element) || !owner) return false;
  const popup = target.closest<HTMLElement>("[data-select-owner]");
  return (
    !!popup &&
    owner.contains(document.getElementById(popup.dataset.selectOwner || ""))
  );
}
