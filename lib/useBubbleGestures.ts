import { useCallback, useEffect, useRef } from "react";

const DOUBLE_TAP_MS = 280;
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

type Callbacks = {
  onDoubleTap: (id: string) => void;
  onMenu: (id: string, el: HTMLElement, viaKeyboard: boolean) => void;
};

type BindOptions = {
  // Photos open the lightbox on a single tap, but only once the double-tap window has passed
  onSingleTap?: () => void;
  // Text bubbles aren't buttons, so Enter/Space opens the menu for keyboard users
  menuOnEnter?: boolean;
};

// Double-tap, long-press, right-click and keyboard context menu for chat bubbles.
// One instance serves every bubble; bind(id) returns the props for one of them.
export function useBubbleGestures(callbacks: Callbacks) {
  const cb = useRef(callbacks);
  useEffect(() => {
    cb.current = callbacks;
  });

  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  const tapTimer = useRef<number | undefined>(undefined);
  const suppressClick = useRef(false);
  const lastPointerDown = useRef(0);
  const lastLongPress = useRef(0);

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };

  useEffect(
    () => () => {
      cancelPress();
      window.clearTimeout(tapTimer.current);
    },
    [],
  );

  return useCallback(
    (id: string, opts: BindOptions = {}) => ({
      onPointerDown(e: React.PointerEvent<HTMLElement>) {
        lastPointerDown.current = Date.now();
        suppressClick.current = false;
        if (e.button !== 0) return; // right-click is handled by onContextMenu
        // Keeps the composer focused (and the keyboard up) when a bubble is touched
        e.preventDefault();
        cancelPress();
        const el = e.currentTarget;
        press.current = {
          x: e.clientX,
          y: e.clientY,
          timer: window.setTimeout(() => {
            press.current = null;
            suppressClick.current = true;
            lastTap.current = null;
            lastLongPress.current = Date.now();
            navigator.vibrate?.(10);
            cb.current.onMenu(id, el, false);
          }, LONG_PRESS_MS),
        };
      },
      onPointerMove(e: React.PointerEvent<HTMLElement>) {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_TOLERANCE_PX) cancelPress();
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onClick(e: React.MouseEvent<HTMLElement>) {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        // detail 0 = activated from the keyboard: no double-tap to wait for
        if (e.detail === 0) {
          opts.onSingleTap?.();
          return;
        }
        const now = Date.now();
        const prev = lastTap.current;
        if (prev && prev.id === id && now - prev.t < DOUBLE_TAP_MS) {
          window.clearTimeout(tapTimer.current);
          lastTap.current = null;
          cb.current.onDoubleTap(id);
          return;
        }
        lastTap.current = { id, t: now };
        window.clearTimeout(tapTimer.current);
        if (opts.onSingleTap) tapTimer.current = window.setTimeout(opts.onSingleTap, DOUBLE_TAP_MS);
      },
      onContextMenu(e: React.MouseEvent<HTMLElement>) {
        e.preventDefault();
        cancelPress();
        // Android fires contextmenu after our own long-press already opened the menu
        if (Date.now() - lastLongPress.current < 1000) return;
        const viaKeyboard = Date.now() - lastPointerDown.current > 1000;
        cb.current.onMenu(id, e.currentTarget, viaKeyboard);
      },
      onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
        if (opts.menuOnEnter && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          cb.current.onMenu(id, e.currentTarget, true);
        }
      },
    }),
    [],
  );
}
