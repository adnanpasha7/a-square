"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { disablePush, enablePush, getPushState, sendTestPush, type PushState } from "@/lib/push";
import type { LiveRole } from "@/lib/live";
import LiveConsent from "./LiveConsent";

const HINTS: Partial<Record<PushState, string>> = {
  "needs-install":
    "On iPhone, notifications only work from the Home Screen app. In Safari, tap Share, then Add to Home Screen. Open A ♥ A from there and come back here.",
  unsupported: "This browser can't show notifications.",
  denied: "Notifications are blocked for this app. Turn them on in your phone's settings, then reopen the app.",
};

export default function Settings({
  userId,
  partnerName,
  liveRole,
  onSeeLive,
  onLiveDisabled,
  onClose,
}: {
  userId: string;
  partnerName: string;
  liveRole: LiveRole | null;
  onSeeLive: () => void;
  onLiveDisabled: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    getPushState().then(setState).catch(() => setState("unsupported"));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      if (state === "on") await disablePush();
      else await enablePush(userId);
      setState(await getPushState());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change notifications.");
      setState(await getPushState());
    }
    setBusy(false);
  }

  async function test() {
    setBusy(true);
    setError(null);
    setTestResult(null);
    try {
      const problem = await sendTestPush();
      if (problem) setError(problem);
      else
        setTestResult(
          "Sent. Go to your Home Screen now: it arrives in about 5 seconds. If it does, this phone is fine, and if messages still don't notify, the Database Webhook in Supabase is missing or has the wrong x-webhook-secret.",
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send a test notification.");
    }
    setBusy(false);
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        {liveRole === "viewer" && (
          <div className="sheet-row">
            <div>
              <h2>Live view</h2>
              <p className="muted">Video only. Nothing is saved or recorded.</p>
            </div>
            <button className="primary" onClick={onSeeLive}>See {partnerName} live</button>
          </div>
        )}
        {/* {liveRole === "sharer" && (
          <LiveConsent sharerId={userId} viewerName={partnerName} onDisabled={onLiveDisabled} />
        )} */}
        <div className="sheet-row">
          <div>
            <h2>Notifications</h2>
            <p className="muted">
              {state === "on" && "On for this device."}
              {state === "off" && "Get a notification when a new message arrives."}
              {state && HINTS[state]}
            </p>
          </div>
          {(state === "on" || state === "off") && (
            <button className={state === "on" ? "ghost" : "primary"} onClick={toggle} disabled={busy}>
              {state === "on" ? "Turn off" : "Turn on"}
            </button>
          )}
        </div>
        {state === "on" && (
          <div className="sheet-row">
            <p className="muted">Not getting notifications? Tap Send test, then go to your Home Screen.</p>
            <button className="ghost" onClick={test} disabled={busy}>Send test</button>
          </div>
        )}
        {testResult && <p className="muted" role="status">{testResult}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="sheet-row">
          <button className="ghost danger" onClick={() => supabase.auth.signOut()}>Sign out</button>
          <button className="ghost" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
