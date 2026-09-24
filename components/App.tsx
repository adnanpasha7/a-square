"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import Login from "./Login";
import Home from "./Home";

// iOS doesn't resize the layout when the keyboard opens, so track the visual viewport
// and size the app shell to it. Keeps the composer glued above the keyboard.
function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--app-h", `${vv.height}px`);
      root.dataset.kb = window.innerHeight - vv.height > 120 ? "1" : "0";
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useVisualViewportHeight();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((e) => console.error("SW registration failed", e));
    }
  }, []);

  if (session === undefined) return <div className="shell" />;
  if (!session) return <Login />;
  return <Home userId={session.user.id} />;
}
