"use client";

import { useEffect, useState } from "react";
import { supabase, type Member, type Message } from "@/lib/supabase";
import { liveRole, useLive } from "@/lib/live";
import Chat from "./Chat";
import Gallery from "./Gallery";
import Lightbox from "./Lightbox";
import Settings from "./Settings";
import LiveView from "./LiveView";
import { Heart, Wordmark } from "./Heart";

type Tab = "chat" | "photos";

export default function Home({ userId }: { userId: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [viewing, setViewing] = useState<Message | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const live = useLive(userId, liveRole(userId));

  useEffect(() => {
    supabase.from("members").select("*").then(({ data, error }) => {
      if (error) console.error(error);
      setMembers(data ?? []);
    });
  }, []);

  // Clear the home-screen badge and stale notifications whenever the app is on screen
  useEffect(() => {
    const clear = async () => {
      if (document.visibilityState !== "visible") return;
      (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {});
      const reg = await navigator.serviceWorker?.getRegistration();
      (await reg?.getNotifications())?.forEach((n) => n.close());
    };
    clear();
    document.addEventListener("visibilitychange", clear);
    return () => document.removeEventListener("visibilitychange", clear);
  }, []);

  if (!members) return <div className="shell" />;

  const me = members.find((m) => m.user_id === userId);
  const partner = members.find((m) => m.user_id !== userId);

  if (!me) {
    return (
      <main className="shell login">
        <Wordmark />
        <div className="login-card">
          <p>This account isn&apos;t set up yet. Add it to the members table in Supabase, then sign in again.</p>
          <button className="primary" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="partner-box">
          <h1 className="partner">
            <span>{partner?.display_name ?? "A"}</span>
            <Heart className="tiny" />
            {live.role === "viewer" && (live.phase === "connecting" || live.phase === "live") && (
              <span className="live-dot" role="img" aria-label="Live view active" />
            )}
          </h1>
          {partnerTyping && <p className="typing-line" aria-hidden="true">typing…</p>}
        </div>
        <nav className="tabs" aria-label="Views">
          <button aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>Chat</button>
          <button aria-pressed={tab === "photos"} onClick={() => setTab("photos")}>Photos</button>
        </nav>
        <button className="icon-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      </header>

      {/* Chat stays mounted so its realtime subscription and scroll position survive tab switches */}
      <div className="view" hidden={tab !== "chat"}>
        <Chat
          userId={userId}
          partnerName={partner?.display_name ?? "They"}
          onOpenImage={setViewing}
          onPartnerTyping={setPartnerTyping}
          active={tab === "chat"}
        />
      </div>
      {tab === "photos" && (
        <div className="view">
          <Gallery onOpenImage={setViewing} />
        </div>
      )}

      {viewing && <Lightbox message={viewing} onClose={() => setViewing(null)} />}
      {settingsOpen && (
        <Settings
          userId={userId}
          partnerName={partner?.display_name ?? "them"}
          liveRole={live.role}
          onSeeLive={() => {
            setSettingsOpen(false);
            live.start();
          }}
          onLiveDisabled={live.end}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      <LiveView live={live} partnerName={partner?.display_name ?? "them"} />
    </main>
  );
}
