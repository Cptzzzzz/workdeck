import { useEffect, useRef, useState, useId } from "react";
import { Minus, Plus, Type as TypeIcon, X } from "lucide-react";
import {
  DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from "./terminal-preferences";

export function TerminalFontControl({
  size,
  onChange,
  onClose,
}: {
  size: number;
  onChange: (size: number) => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const close = () => {
    setOpen(false);
    onClose();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as HTMLElement))
        setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        onClose();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [open, onClose]);
  return (
    <div className="terminal-font-control" ref={container}>
      <button
        type="button"
        className="icon-button"
        aria-label="终端字号"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`终端字号：${size} px`}
        onClick={() => setOpen(!open)}
      >
        <TypeIcon size={16} />
      </button>
      {open && (
        <div
          className="terminal-font-panel"
          role="dialog"
          aria-label="终端字号设置"
        >
          <div className="terminal-font-title">
            <b>终端字号</b>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭字号设置"
              onClick={close}
            >
              <X size={15} />
            </button>
          </div>
          <label htmlFor={id}>字号</label>
          <span className="terminal-font-input">
            <button
              type="button"
              className="secondary"
              aria-label="减小字号"
              disabled={size <= MIN_FONT_SIZE}
              onClick={() => onChange(size - 1)}
            >
              <Minus size={14} />
            </button>
            <select
              id={id}
              value={size}
              onChange={(event) => onChange(Number(event.target.value))}
            >
              {Array.from(
                { length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 },
                (_, i) => i + MIN_FONT_SIZE,
              ).map((value) => (
                <option key={value} value={value}>
                  {value} px
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary"
              aria-label="增大字号"
              disabled={size >= MAX_FONT_SIZE}
              onClick={() => onChange(size + 1)}
            >
              <Plus size={14} />
            </button>
          </span>
          <p>即时生效，应用于当前浏览器的所有终端。</p>
          <button
            type="button"
            className="terminal-font-reset"
            onClick={() => onChange(DEFAULT_FONT_SIZE)}
          >
            恢复默认（{DEFAULT_FONT_SIZE} px）
          </button>
        </div>
      )}
    </div>
  );
}
