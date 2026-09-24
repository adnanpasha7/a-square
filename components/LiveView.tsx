"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isIOS } from "@/lib/push";
import type { Live, LiveNote } from "@/lib/live";

function Video({ stream, mirrored = false, className }: { stream: MediaStream | null; mirrored?: boolean; className: string }) {
  return (
    <video
      className={`${className} ${mirrored ? "mirrored" : ""}`}
      playsInline
      autoPlay
      muted
      ref={(el) => {
        if (el && el.srcObject !== stream) {
          el.srcObject = stream;
          el.play().catch(() => {});
        }
      }}
    />
  );
}

function cameraHelp() {
  return isIOS()
    ? "On iPhone: Settings → Apps → Safari → Camera → Allow (or Ask), then close and reopen A ♥ A."
    : "On Android: long-press the A ♥ A icon → App info → Permissions → Camera → Allow. Or in Chrome: ⋮ → Settings → Site settings → Camera.";
}

function noteText(note: LiveNote, other: string, role: "viewer" | "sharer"): string {
  switch (note) {
    case "no-answer": return `${other} didn't respond. A ♥ A may not be open on her phone.`;
    case "declined": return `${other} said not right now.`;
    case "expired": return `${other} didn't answer in time.`;
    case "away": return `${other} isn't in the app right now.`;
    case "camera-unavailable": return `${other}'s camera couldn't start.`;
    case "ended-by-peer": return role === "viewer" ? `${other} ended the live view.` : `${other} stopped watching.`;
    case "connection-lost": return "The connection dropped, so the live view ended.";
    case "backgrounded": return "The live view ended because the app left the screen.";
    case "offline": return "Couldn't reach the live service. Check your connection and try again.";
    case "camera-blocked": return `Camera access is blocked for A ♥ A. ${cameraHelp()}`;
    case "camera-missing": return "No camera was found on this device.";
    case "camera-busy": return "The camera is being used by another app. Close it and try again.";
    case "camera-error": return "The camera couldn't start. Please try again.";
  }
}

export default function LiveView({ live, partnerName }: { live: Live; partnerName: string }) {
  const { role, phase } = live;
  const [now, setNow] = useState(() => Date.now());

  // Countdown on her request prompt
  useEffect(() => {
    if (phase !== "incoming") return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [phase]);

  // Viewer-side end notices clear themselves; camera problems on her side wait for OK
  useEffect(() => {
    if (phase !== "ended" || live.note?.startsWith("camera-")) return;
    const t = window.setTimeout(live.dismiss, role === "viewer" ? 6000 : 3500);
    return () => window.clearTimeout(t);
  }, [phase, live.note, live.dismiss, role]);

  if (!role || phase === "idle") return null;

  // if (phase === "ended" && live.note) {
  //   return (
  //     <div className="live-toast" role="alert">
  //       <p>{noteText(live.note, partnerName, role)}</p>
  //       <button className="ghost" onClick={live.dismiss}>OK</button>
  //     </div>
  //   );
  // }

  // ---------- viewer: small floating window, drag it anywhere and keep chatting ----------
  if (role === "viewer") return <ViewerWindow live={live} partnerName={partnerName} />;

  // ---------- sharer: the request prompt ----------
  if (phase === "incoming") {
    const secondsLeft = Math.max(0, Math.ceil(((live.expiresAt ?? now) - now) / 1000));
    return (
      <div className="live-prompt" role="alertdialog" aria-modal="true" aria-labelledby="live-prompt-title">
        <div className="live-prompt-card">
          <span className="live-prompt-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30">
              <rect x="2.5" y="6" width="13" height="12" rx="3" />
              <path d="m15.5 10.5 6-3.5v10l-6-3.5z" />
            </svg>
          </span>
          <h2 id="live-prompt-title">{partnerName} wants to see you live</h2>
          <p className="muted">
            Your camera turns on for this one time only. Video only, no sound. Nothing is saved or recorded, and you
            can end it anytime.
          </p>
          <p className="live-countdown" aria-live="off">Expires in {secondsLeft}s</p>
          <div className="live-prompt-actions">
            <button className="ghost" onClick={live.decline}>Decline</button>
            <button className="primary" onClick={live.accept}>Accept</button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- sharer: always-visible LIVE bar while the camera is on ----------
  return null;
}

const EDGE = 8;

function ViewerWindow({ live, partnerName }: { live: Live; partnerName: string }) {
  const { phase } = live;
  const boxRef = useRef<HTMLDivElement>(null);
  const [big, setBig] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);

  // Keep the window fully on screen
  const clamp = useCallback((x: number, y: number) => {
    const el = boxRef.current;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;
    return {
      x: Math.min(Math.max(EDGE, x), window.innerWidth - w - EDGE),
      y: Math.min(Math.max(EDGE, y), window.innerHeight - h - EDGE),
    };
  }, []);

  // Start in the top-right corner, below the header
  useEffect(() => {
    const el = boxRef.current;
    if (el) setPos(clamp(window.innerWidth - el.offsetWidth - 12, 72));
  }, [clamp]);

  // Re-clamp when resized or the window is enlarged/shrunk
  useEffect(() => {
    const fit = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [big, clamp]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button") || !pos) return;
    drag.current = { id: e.pointerId, dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    setPos(clamp(e.clientX - d.dx, e.clientY - d.dy));
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };

  const status =
    phase === "asking" ? `Asking ${partnerName}…`
    : phase === "waiting" ? "Waiting for her…"
    : phase === "connecting" ? "Connecting…"
    : "Live";

  return (
    <div
      ref={boxRef}
      className={`live-float ${big ? "big" : ""}`}
      style={pos ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : { visibility: "hidden" }}
      role="region"
      aria-label={`${partnerName} live`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Video stream={live.remoteStream} className="live-video" />
      <p className={`live-status ${phase === "live" ? "on" : ""}`} role="status">
        {phase === "live" && <span className="live-dot" aria-hidden="true" />}
        {status}
      </p>
      {live.turnWarning && <p className="live-warning">No relay server. Mobile data may fail.</p>}
      <button
        className="live-float-btn live-size"
        onClick={() => setBig((b) => !b)}
        aria-label={big ? "Make live view smaller" : "Make live view bigger"}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          {big ? <path d="M9 4v5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 15v5h-5" />}
        </svg>
      </button>
      <button className="live-float-btn live-end" onClick={live.end} aria-label="End live view">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  );
}
