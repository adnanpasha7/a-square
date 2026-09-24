"use client";

import { useEffect, useState } from "react";
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

  if (phase === "ended" && live.note) {
    return (
      <div className="live-toast" role="alert">
        <p>{noteText(live.note, partnerName, role)}</p>
        <button className="ghost" onClick={live.dismiss}>OK</button>
      </div>
    );
  }

  // ---------- viewer: full-screen, receive-only ----------
  if (role === "viewer") {
    const status =
      phase === "asking" ? `Asking ${partnerName}…`
      : phase === "waiting" ? "Waiting for her…"
      : phase === "connecting" ? "Connecting…"
      : "Live";
    return (
      <div className="live-screen" role="dialog" aria-modal="true" aria-label={`${partnerName} live`}>
        <Video stream={live.remoteStream} className="live-video" />
        <div className="live-top">
          <p className={`live-status ${phase === "live" ? "on" : ""}`} role="status">
            {phase === "live" && <span className="live-dot" aria-hidden="true" />}
            {status}
          </p>
          {live.turnWarning && (
            <p className="live-warning">No relay server available. Connections over mobile data may fail.</p>
          )}
        </div>
        <button className="live-end" onClick={live.end} aria-label="End live view">End</button>
      </div>
    );
  }

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
  return (
    <div className="live-share" role="status" aria-label={`Live. ${partnerName} is watching.`}>
      <Video stream={live.localStream} mirrored={live.facing === "user"} className="live-preview" />
      <div className="live-share-text">
        <strong>
          <span className="live-dot" aria-hidden="true" />
          {phase === "live" ? `LIVE — ${partnerName} is watching` : `LIVE — connecting to ${partnerName}…`}
        </strong>
        <span>Video only · nothing is recorded</span>
      </div>
      <button className="live-flip" onClick={live.flip} aria-label="Switch between front and back camera" disabled={!live.localStream}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 9.5V8a2 2 0 0 1 2-2h2l1.4-2h5.2L16 6h2a2 2 0 0 1 2 2v1.5" />
          <path d="M20 14.5V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5" />
          <path d="m7 12.5 2-2.5 2 2.5M17 11.5l-2 2.5-2-2.5" />
        </svg>
      </button>
      <button className="live-share-end" onClick={live.end} aria-label="End live view">End</button>
    </div>
  );
}
