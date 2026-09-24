"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { Wordmark } from "./Heart";

// Email + password rather than magic links: on iOS a magic link opens in Safari,
// which doesn't share storage with the home-screen app, so you'd never get logged in there.
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) setError(error.message === "Invalid login credentials" ? "That email and password don't match." : error.message);
    setBusy(false);
  }

  return (
    <main className="shell login">
      <Wordmark />
      <form className="login-card" onSubmit={submit}>
        <label>
          <span>Email</span>
          <input type="email" autoComplete="email" inputMode="email" value={email}
            onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          <span>Password</span>
          <input type="password" autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
