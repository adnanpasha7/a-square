"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, BUCKET, type Message } from "@/lib/supabase";
import { prepareImage } from "@/lib/image";
import { signMany } from "@/lib/signed-urls";
import { dayKey, dayLabel, timeLabel } from "@/lib/dates";
import { Heart } from "./Heart";

const PAGE = 40;
const GROUP_GAP_MS = 3 * 60 * 1000;

// Local-only fields for optimistic UI
type UIMessage = Message & { _pending?: boolean; _failed?: boolean; _preview?: string; _retry?: () => void };

function sortedUpsert(list: UIMessage[], incoming: UIMessage[]) {
  const map = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) {
    const existing = map.get(m.id);
    // keep the local preview so the bubble doesn't flicker while the signed URL loads
    map.set(m.id, existing?._preview && !m._preview ? { ...m, _preview: existing._preview } : m);
  }
  return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export default function Chat({
  userId,
  onOpenImage,
  active,
}: {
  userId: string;
  onOpenImage: (m: Message) => void;
  active: boolean;
}) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const merge = useCallback((incoming: UIMessage[]) => setMessages((prev) => sortedUpsert(prev, incoming)), []);

  const fetchLatest = useCallback(async () => {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (error) return console.error(error);
    merge(data);
    setLoaded(true);
    return data.length;
  }, [merge]);

  // Initial load
  useEffect(() => {
    fetchLatest().then((n) => setHasMore(n === PAGE));
  }, [fetchLatest]);

  // Realtime: new messages + read receipts
  useEffect(() => {
    const channel = supabase
      .channel("messages-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) =>
        merge([p.new as Message]),
      )
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) =>
        merge([p.new as Message]),
      )
      .subscribe();

    // Phones kill websockets when the app is backgrounded. Catch up on anything missed.
    const onVisible = () => document.visibilityState === "visible" && fetchLatest();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [merge, fetchLatest]);

  // Sign thumbnail URLs for any image messages we haven't signed yet
  useEffect(() => {
    const need = messages.filter((m) => m.thumb_path && !urls[m.thumb_path] && !m._pending && !m._failed).map((m) => m.thumb_path!);
    if (!need.length) return;
    signMany(need)
      .then((signed) => setUrls((u) => ({ ...u, ...signed })))
      .catch(console.error);
  }, [messages, urls]);

  // Read receipts: mark their messages read while the chat is actually on screen
  useEffect(() => {
    if (!active || document.visibilityState !== "visible") return;
    const unread = messages.some((m) => m.sender_id !== userId && !m.read_at);
    if (!unread) return;
    supabase.rpc("mark_read").then(({ error }) => {
      if (error) return console.error(error);
      const now = new Date().toISOString();
      setMessages((prev) => prev.map((m) => (m.sender_id !== userId && !m.read_at ? { ...m, read_at: now } : m)));
    });
  }, [messages, active, userId]);

  // With column-reverse, scrollTop 0 is the bottom. Jump there when I send something.
  const scrollToBottom = () => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });

  async function loadOlder() {
    const oldest = messages.find((m) => !m._pending);
    if (!oldest) return;
    setLoadingOlder(true);
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .lt("created_at", oldest.created_at)
      .order("created_at", { ascending: false })
      .limit(PAGE);
    setLoadingOlder(false);
    if (error) return console.error(error);
    merge(data);
    setHasMore(data.length === PAGE);
  }

  function blank(id: string): UIMessage {
    return {
      id,
      sender_id: userId,
      body: null,
      image_path: null,
      thumb_path: null,
      image_width: null,
      image_height: null,
      created_at: new Date().toISOString(),
      read_at: null,
      _pending: true,
    };
  }

  async function sendText(body: string, id = crypto.randomUUID()) {
    const optimistic: UIMessage = { ...blank(id), body };
    merge([optimistic]);
    scrollToBottom();

    const { data, error } = await supabase.from("messages").insert({ id, body }).select().single();
    if (error) {
      console.error(error);
      merge([{ ...optimistic, _pending: false, _failed: true, _retry: () => sendText(body, id) }]);
    } else {
      merge([data]);
    }
  }

  async function sendPhoto(file: File, id = crypto.randomUUID()) {
    let prepared;
    try {
      prepared = await prepareImage(file);
    } catch (e) {
      console.error(e);
      alert("That file couldn't be read as a photo.");
      return;
    }
    const { full, thumb } = prepared;
    const preview = URL.createObjectURL(thumb.blob);
    const optimistic: UIMessage = {
      ...blank(id),
      image_path: "pending",
      thumb_path: "pending",
      image_width: full.width,
      image_height: full.height,
      _preview: preview,
    };
    merge([optimistic]);
    scrollToBottom();

    const fullPath = `${userId}/${id}.jpg`;
    const thumbPath = `${userId}/${id}_thumb.jpg`;
    const opts = { contentType: "image/jpeg", cacheControl: "31536000", upsert: true };

    try {
      const [a, b] = await Promise.all([
        supabase.storage.from(BUCKET).upload(fullPath, full.blob, opts),
        supabase.storage.from(BUCKET).upload(thumbPath, thumb.blob, opts),
      ]);
      if (a.error) throw a.error;
      if (b.error) throw b.error;

      const { data, error } = await supabase
        .from("messages")
        .insert({ id, image_path: fullPath, thumb_path: thumbPath, image_width: full.width, image_height: full.height })
        .select()
        .single();
      if (error) throw error;
      merge([{ ...data, _preview: preview }]);
    } catch (e) {
      console.error(e);
      merge([{ ...optimistic, _pending: false, _failed: true, _retry: () => sendPhoto(file, id) }]);
    }
  }

  function submit() {
    const body = text.trim();
    if (!body) return;
    setText("");
    sendText(body);
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow picking the same photo again
    for (const f of files) await sendPhoto(f); // sequential keeps order and memory sane
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends on a real keyboard; on phones Return adds a new line and you tap Send
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (e.key === "Enter" && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  // Auto-grow the textarea up to ~5 lines
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  // ---- build the rows (chronological), then reverse for the column-reverse scroller ----
  const lastMine = [...messages].reverse().find((m) => m.sender_id === userId && !m._pending && !m._failed);
  const rows: React.ReactNode[] = [];

  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const mine = m.sender_id === userId;
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
    const groupedWithPrev =
      !newDay && prev?.sender_id === m.sender_id &&
      new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < GROUP_GAP_MS;
    const endsGroup =
      !next || next.sender_id !== m.sender_id || dayKey(next.created_at) !== dayKey(m.created_at) ||
      new Date(next.created_at).getTime() - new Date(m.created_at).getTime() >= GROUP_GAP_MS;

    if (newDay) rows.push(<div key={`d-${m.id}`} className="day">{dayLabel(m.created_at)}</div>);

    const src = m._preview ?? (m.thumb_path ? urls[m.thumb_path] : undefined);

    rows.push(
      <div key={m.id} className={`msg ${mine ? "mine" : "theirs"} ${groupedWithPrev ? "grouped" : ""}`}>
        {m.image_path ? (
          <button
            className={`photo ${m._pending ? "sending" : ""}`}
            onClick={() => !m._pending && !m._failed && onOpenImage(m)}
            aria-label="Open photo"
            style={{ aspectRatio: m.image_width && m.image_height ? `${m.image_width} / ${m.image_height}` : "1" }}
          >
            {src && <img src={src} alt="" loading="lazy" decoding="async" />}
          </button>
        ) : (
          <div className={`bubble ${m._pending ? "sending" : ""}`}>{m.body}</div>
        )}
        {m._failed && (
          <button className="failed" onClick={m._retry}>Not sent. Tap to retry.</button>
        )}
        {endsGroup && !m._failed && (
          <div className="meta">
            {m._pending ? "Sending…" : timeLabel(m.created_at)}
            {lastMine?.id === m.id && m.read_at && <span className="seen">, seen <Heart className="micro" /></span>}
          </div>
        )}
      </div>,
    );
  });

  return (
    <div className="chat">
      <div className="scroller" ref={scrollRef}>
        <div className="scroller-inner">
          {rows.reverse()}
          {loaded && messages.length === 0 && (
            <p className="empty">Just the two of you in here. Say something sweet.</p>
          )}
          {hasMore && (
            <button className="load-older" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? "Loading…" : "Load earlier messages"}
            </button>
          )}
        </div>
      </div>

      <div className="composer">
        <button className="icon-btn attach" aria-label="Send a photo" onClick={() => fileRef.current?.click()}>
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
            <circle cx="12" cy="12.5" r="3.5" />
          </svg>
        </button>
        {/* No `capture` attribute: both iOS and Android then offer camera AND library in one picker */}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder="Message"
          enterKeyHint="send"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="send"
          aria-label="Send"
          disabled={!text.trim()}
          // preventDefault on pointerdown keeps the textarea focused, so the keyboard stays up
          onPointerDown={(e) => e.preventDefault()}
          onClick={submit}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
            <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
