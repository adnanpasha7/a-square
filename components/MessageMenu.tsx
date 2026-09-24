"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const QUICK_EMOJIS = ["❤️", "😂", "😮", "😢", "🔥", "👍"];

const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

function firstGrapheme(s: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) return segment;
    return "";
  }
  return Array.from(s)[0] ?? "";
}

type Mode = "main" | "pick" | "confirm";

export default function MessageMenu({
  anchor,
  align,
  myEmoji,
  canCopy,
  canEdit,
  canUnsend,
  autoFocus,
  onReact,
  onCopy,
  onEdit,
  onUnsend,
  onClose,
}: {
  anchor: HTMLElement;
  align: "start" | "end";
  myEmoji?: string;
  canCopy: boolean;
  canEdit: boolean;
  canUnsend: boolean;
  autoFocus: boolean;
  onReact: (emoji: string) => void;
  onCopy: () => void;
  onEdit: () => void;
  onUnsend: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("main");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [hint, setHint] = useState("Open the emoji keyboard and pick one");
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Sit above the bubble if there's room, otherwise below; stay inside the (keyboard-shrunk) viewport
  useLayoutEffect(() => {
    const place = () => {
      const card = cardRef.current;
      if (!card) return;
      const r = anchor.getBoundingClientRect();
      const m = 8;
      const vw = window.innerWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const minTop = Math.min((document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0) + m, vh - h - m);
      let top = r.top - h - m;
      if (top < minTop) top = r.bottom + m;
      top = Math.max(m, Math.min(top, vh - h - m));
      const left = Math.max(m, Math.min(align === "end" ? r.right - w : r.left, vw - w - m));
      setPos({ top, left });
    };
    place();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", place);
    window.addEventListener("resize", place);
    return () => {
      vv?.removeEventListener("resize", place);
      window.removeEventListener("resize", place);
    };
  }, [anchor, align, mode]);

  // Esc closes; scrolling anything closes (except while the emoji keyboard is opening,
  // which scrolls and resizes the viewport on iOS)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onScroll = () => mode !== "pick" && onClose();
    window.addEventListener("keydown", onKey);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [mode, onClose]);

  // Keyboard users land on the first item; touch users keep the composer focused
  useEffect(() => {
    if (autoFocus && mode !== "pick") cardRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [autoFocus, mode]);

  function openPicker() {
    // Focus synchronously inside the tap, otherwise iOS won't raise the keyboard
    inputRef.current?.focus();
    setMode("pick");
  }

  function onPickInput(e: React.ChangeEvent<HTMLInputElement>) {
    const value = e.target.value.trim();
    if (!value) return;
    const g = firstGrapheme(value);
    if (EMOJI_RE.test(g) && Array.from(g).length <= 16) {
      onReact(g);
    } else {
      e.target.value = "";
      setHint("That's not an emoji, try the emoji keyboard");
    }
  }

  // Arrow keys move between items
  function onCardKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || e.target instanceof HTMLInputElement) return;
    const items = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + step + items.length) % items.length].focus();
  }

  const quick = myEmoji && !QUICK_EMOJIS.includes(myEmoji) ? [...QUICK_EMOJIS, myEmoji] : QUICK_EMOJIS;
  const close = () => onClose();

  return createPortal(
    <div
      className="menu-layer"
      onClick={(e) => e.target === e.currentTarget && close()}
      onTouchMove={(e) => e.target === e.currentTarget && close()}
      onWheel={close}
      onContextMenu={(e) => {
        e.preventDefault();
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={cardRef}
        className={`msg-menu ${align === "end" ? "from-end" : "from-start"}`}
        role="menu"
        aria-label="Message actions"
        style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
        onKeyDown={onCardKeyDown}
      >
        {mode === "main" && (
          <>
            <div className="menu-emojis">
              {quick.map((emoji) => {
                const on = myEmoji === emoji;
                return (
                  <button
                    key={emoji}
                    role="menuitemradio"
                    aria-checked={on}
                    aria-label={on ? `Remove ${emoji} reaction` : `React with ${emoji}`}
                    className={on ? "on" : ""}
                    onClick={() => onReact(emoji)}
                  >
                    {emoji}
                  </button>
                );
              })}
              <button role="menuitem" className="menu-more" aria-label="React with any emoji" onClick={openPicker}>
                +
              </button>
            </div>
            {(canCopy || canEdit || canUnsend) && (
              <div className="menu-actions">
                {canCopy && (
                  <button role="menuitem" className="menu-item" onClick={onCopy}>
                    Copy
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="8" y="8" width="12" height="12" rx="2.5" />
                      <path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" />
                    </svg>
                  </button>
                )}
                {canEdit && (
                  <button role="menuitem" className="menu-item" onClick={onEdit}>
                    Edit
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
                      <path d="m13.5 6.5 4 4" />
                    </svg>
                  </button>
                )}
                {canUnsend && (
                  <button role="menuitem" className="menu-item danger" onClick={() => setMode("confirm")}>
                    Unsend
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M9 14 4 9l5-5" />
                      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {mode === "confirm" && (
          <div className="menu-confirm">
            <p>Unsend this message?</p>
            <div className="menu-confirm-row">
              <button className="ghost" onClick={close}>Cancel</button>
              <button className="menu-unsend" onClick={onUnsend}>Unsend</button>
            </div>
          </div>
        )}

        {/* Always mounted (visually hidden until "+"), so it can be focused inside the tap */}
        <div className={`menu-pick ${mode === "pick" ? "open" : ""}`}>
          <input
            ref={inputRef}
            type="text"
            aria-label="Type any emoji"
            placeholder="Any emoji"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            tabIndex={mode === "pick" ? 0 : -1}
            onChange={onPickInput}
          />
          {mode === "pick" && <p className="menu-hint">{hint}</p>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
