"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, BUCKET, type Message, type Reaction } from "@/lib/supabase";
import { prepareImage } from "@/lib/image";
import { signMany } from "@/lib/signed-urls";
import { dayKey, dayLabel, timeLabel } from "@/lib/dates";
import { useBubbleGestures } from "@/lib/useBubbleGestures";
import { Heart } from "./Heart";
import MessageMenu from "./MessageMenu";
import { ReactionChip } from "./Reactions";
import TypingBubble from "./TypingBubble";

const PAGE = 40;
const GROUP_GAP_MS = 3 * 60 * 1000;
const TYPING_SEND_EVERY_MS = 2000;
const TYPING_HIDE_AFTER_MS = 4000;
const HEART = "❤️";

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

// Reactions, edit and unsend only apply to messages that exist on the server and are still there
const canInteract = (m: UIMessage) => !m._pending && !m._failed && !m.deleted_at;

export default function Chat({
  userId,
  partnerName,
  onOpenImage,
  onPartnerTyping,
  active,
}: {
  userId: string;
  partnerName: string;
  onOpenImage: (m: Message) => void;
  onPartnerTyping: (typing: boolean) => void;
  active: boolean;
}) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [reactions, setReactions] = useState<Record<string, Reaction[]>>({});
  const [menu, setMenu] = useState<{ id: string; el: HTMLElement; viaKeyboard: boolean } | null>(null);
  const [editing, setEditing] = useState<UIMessage | null>(null);
  const [pop, setPop] = useState<{ id: string; key: number } | null>(null);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const draftRef = useRef(""); // what was in the composer before an edit started
  const roomRef = useRef<RealtimeChannel | null>(null);
  const roomReady = useRef(false);
  const lastTypingSent = useRef(0);
  const partnerTypingTimer = useRef<number | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const merge = useCallback((incoming: UIMessage[]) => setMessages((prev) => sortedUpsert(prev, incoming)), []);

  // Set (or clear, with null) one person's reaction on one message
  const putReaction = useCallback(
    (messageId: string, uid: string, r: Reaction | null) =>
      setReactions((prev) => {
        const list = (prev[messageId] ?? []).filter((x) => x.user_id !== uid);
        if (r) list.push(r);
        const next = { ...prev };
        if (list.length) next[messageId] = list;
        else delete next[messageId];
        return next;
      }),
    [],
  );

  const clearReactions = useCallback(
    (messageId: string) =>
      setReactions((prev) => {
        if (!prev[messageId]) return prev;
        const next = { ...prev };
        delete next[messageId];
        return next;
      }),
    [],
  );

  // One query for every message just loaded; replaces what we had for those ids
  const loadReactions = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const { data, error } = await supabase.from("reactions").select("*").in("message_id", ids);
    if (error) return console.error(error);
    setReactions((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      for (const r of data as Reaction[]) (next[r.message_id] ??= []).push(r);
      return next;
    });
  }, []);

  const hidePartnerTyping = useCallback(() => {
    window.clearTimeout(partnerTypingTimer.current);
    setPartnerTyping(false);
  }, []);

  const fetchLatest = useCallback(async () => {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (error) return console.error(error);
    merge(data);
    setLoaded(true);
    loadReactions(data.map((m) => m.id));
    return data.length;
  }, [merge, loadReactions]);

  // Initial load
  useEffect(() => {
    fetchLatest().then((n) => setHasMore(n === PAGE));
  }, [fetchLatest]);

  // Realtime: new messages, read receipts / edits / unsends, and reactions
  useEffect(() => {
    const channel = supabase
      .channel("messages-feed", { config: { private: true } })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
        merge([m]);
        if (m.sender_id !== userId) hidePartnerTyping();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages" }, (p) => {
        const m = p.new as Message;
        merge([m]);
        if (m.deleted_at) clearReactions(m.id);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "reactions" }, (p) => {
        if (p.eventType === "DELETE") {
          // DELETE only carries the primary key, which is all we need
          const old = p.old as Partial<Reaction>;
          if (old.message_id && old.user_id) putReaction(old.message_id, old.user_id, null);
        } else {
          const r = p.new as Reaction;
          putReaction(r.message_id, r.user_id, r);
        }
      })
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
  }, [merge, fetchLatest, userId, hidePartnerTyping, clearReactions, putReaction]);

  // Typing indicator: ephemeral broadcast, nothing touches the database
  useEffect(() => {
    const room = supabase
      .channel("room", { config: { private: true, broadcast: { self: false } } })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (payload?.user_id === userId) return; // my other devices
        setPartnerTyping(true);
        window.clearTimeout(partnerTypingTimer.current);
        partnerTypingTimer.current = window.setTimeout(() => setPartnerTyping(false), TYPING_HIDE_AFTER_MS);
      })
      .on("broadcast", { event: "stop" }, ({ payload }) => {
        if (payload?.user_id !== userId) hidePartnerTyping();
      })
      .subscribe((status) => {
        roomReady.current = status === "SUBSCRIBED";
      });
    roomRef.current = room;

    return () => {
      if (roomReady.current && lastTypingSent.current) {
        room.send({ type: "broadcast", event: "stop", payload: { user_id: userId } });
      }
      roomReady.current = false;
      roomRef.current = null;
      lastTypingSent.current = 0;
      window.clearTimeout(partnerTypingTimer.current);
      supabase.removeChannel(room);
    };
  }, [userId, hidePartnerTyping]);

  useEffect(() => onPartnerTyping(partnerTyping), [partnerTyping, onPartnerTyping]);

  // If the message being edited gets unsent (e.g. from my other phone), drop out of edit mode
  useEffect(() => {
    if (editing && messages.find((m) => m.id === editing.id)?.deleted_at) {
      setEditing(null);
      setText(draftRef.current);
      draftRef.current = "";
    }
  }, [messages, editing]);

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
    loadReactions(data.map((m) => m.id));
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
      edited_at: null,
      deleted_at: null,
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

  // ---------- typing (outgoing) ----------
  function broadcastTyping(event: "typing" | "stop") {
    if (roomReady.current) roomRef.current?.send({ type: "broadcast", event, payload: { user_id: userId } });
  }

  function stopTyping() {
    if (!lastTypingSent.current) return;
    lastTypingSent.current = 0;
    broadcastTyping("stop");
  }

  function onTextChange(value: string) {
    setText(value);
    if (editing) return; // fixing an old message isn't "typing…"
    if (!value.trim()) return stopTyping();
    const now = Date.now();
    if (now - lastTypingSent.current >= TYPING_SEND_EVERY_MS) {
      lastTypingSent.current = now;
      broadcastTyping("typing");
    }
  }

  // ---------- reactions ----------
  async function react(m: UIMessage, emoji: string) {
    if (!canInteract(m)) return;
    const current = reactions[m.id]?.find((r) => r.user_id === userId) ?? null;
    const removing = current?.emoji === emoji;
    putReaction(
      m.id,
      userId,
      removing ? null : { message_id: m.id, user_id: userId, emoji, created_at: current?.created_at ?? new Date().toISOString() },
    );
    if (!removing && emoji === HEART) setPop({ id: m.id, key: Date.now() });

    const { error } = removing
      ? await supabase.from("reactions").delete().eq("message_id", m.id).eq("user_id", userId)
      : await supabase
          .from("reactions")
          .upsert({ message_id: m.id, user_id: userId, emoji }, { onConflict: "message_id,user_id" });
    if (error) {
      console.error(error);
      putReaction(m.id, userId, current);
    }
  }

  useEffect(() => {
    if (!pop) return;
    const t = window.setTimeout(() => setPop(null), 800);
    return () => window.clearTimeout(t);
  }, [pop]);

  // ---------- edit ----------
  function startEdit(m: UIMessage) {
    if (!editing) draftRef.current = text;
    stopTyping();
    setEditing(m);
    setText(m.body ?? "");
    // Synchronously inside the tap, so iOS raises the keyboard
    inputRef.current?.focus();
  }

  function cancelEdit() {
    setEditing(null);
    setText(draftRef.current);
    draftRef.current = "";
  }

  // Cursor at the end of the prefilled text
  useEffect(() => {
    const el = inputRef.current;
    if (editing && el) el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  async function saveEdit(original: UIMessage, body: string) {
    cancelEdit();
    if (body === original.body) return;
    const restore = { body: original.body, edited_at: original.edited_at };
    setMessages((prev) => prev.map((x) => (x.id === original.id ? { ...x, body, edited_at: new Date().toISOString() } : x)));

    const { data, error } = await supabase.rpc("edit_message", { p_id: original.id, p_body: body });
    if (error) {
      console.error(error);
      setMessages((prev) => prev.map((x) => (x.id === original.id ? { ...x, ...restore } : x)));
      alert("That edit didn't save. Please try again.");
    } else if (data) {
      merge([data as Message]);
    }
  }

  // ---------- unsend ----------
  async function unsend(m: UIMessage) {
    if (!canInteract(m) || m.sender_id !== userId) return;
    // Capture the file paths now; the RPC clears them
    const paths = [m.image_path, m.thumb_path].filter((p): p is string => !!p && p !== "pending");
    const previousReactions = reactions[m.id];
    if (editing?.id === m.id) cancelEdit();

    const gone = {
      deleted_at: new Date().toISOString(),
      body: null,
      image_path: null,
      thumb_path: null,
      image_width: null,
      image_height: null,
      edited_at: null,
    };
    setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...gone } : x)));
    clearReactions(m.id);

    const { error } = await supabase.rpc("unsend_message", { p_id: m.id });
    if (error) {
      console.error(error);
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...m, read_at: x.read_at } : x)));
      if (previousReactions) setReactions((prev) => ({ ...prev, [m.id]: previousReactions }));
      alert("Couldn't unsend that message. Please try again.");
      return;
    }
    if (paths.length) {
      const { error: storageError } = await supabase.storage.from(BUCKET).remove(paths);
      if (storageError) console.error(storageError);
    }
  }

  // ---------- menu + gestures ----------
  function closeMenu() {
    if (menu?.viaKeyboard) menu.el.focus({ preventScroll: true });
    setMenu(null);
  }

  const bind = useBubbleGestures({
    onDoubleTap: (id) => {
      const m = messages.find((x) => x.id === id);
      if (m) react(m, HEART);
    },
    onMenu: (id, el, viaKeyboard) => setMenu({ id, el, viaKeyboard }),
  });

  function submit() {
    const body = text.trim();
    if (!body) return;
    if (editing) {
      saveEdit(editing, body);
      return;
    }
    setText("");
    stopTyping();
    sendText(body);
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow picking the same photo again
    for (const f of files) await sendPhoto(f); // sequential keeps order and memory sane
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && editing) {
      e.preventDefault();
      cancelEdit();
      return;
    }
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
    const side = `${mine ? "mine" : "theirs"} ${groupedWithPrev ? "grouped" : ""}`;
    const seen = lastMine?.id === m.id && m.read_at && <span className="seen">, seen <Heart className="micro" /></span>;
    const meta = (content: React.ReactNode) => <div className="meta">{content}</div>;

    if (m.deleted_at) {
      rows.push(
        <div key={m.id} className={`msg ${side} unsent`}>
          <p className="unsent-note">{mine ? "You unsent a message" : `${partnerName} unsent a message`}</p>
          {endsGroup && meta(<>{timeLabel(m.created_at)}{seen}</>)}
        </div>,
      );
      return;
    }

    const interactive = canInteract(m);
    const rx = reactions[m.id] ?? [];

    rows.push(
      <div key={m.id} className={`msg ${side} ${editing?.id === m.id ? "editing" : ""}`}>
        <div className={`bubble-wrap ${rx.length ? "has-reactions" : ""}`}>
          {m.image_path ? (
            <button
              className={`photo ${m._pending ? "sending" : ""}`}
              aria-label="Open photo"
              aria-haspopup={interactive ? "menu" : undefined}
              style={{ aspectRatio: m.image_width && m.image_height ? `${m.image_width} / ${m.image_height}` : "1" }}
              {...(interactive ? bind(m.id, { onSingleTap: () => onOpenImage(m) }) : {})}
            >
              {src && <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />}
            </button>
          ) : (
            <div
              className={`bubble ${m._pending ? "sending" : ""}`}
              tabIndex={interactive ? 0 : undefined}
              aria-haspopup={interactive ? "menu" : undefined}
              {...(interactive ? bind(m.id, { menuOnEnter: true }) : {})}
            >
              {m.body}
            </div>
          )}
          {pop?.id === m.id && (
            <span key={pop.key} className="heart-pop" aria-hidden="true">
              <Heart />
            </span>
          )}
          <ReactionChip reactions={rx} userId={userId} partnerName={partnerName} />
        </div>
        {m._failed && (
          <button className="failed" onClick={m._retry}>Not sent. Tap to retry.</button>
        )}
        {(endsGroup || m.edited_at) && !m._failed &&
          meta(
            <>
              {m._pending ? "Sending…" : timeLabel(m.created_at)}
              {m.edited_at && <span className="edited"> · edited</span>}
              {seen}
            </>,
          )}
      </div>,
    );
  });

  const menuMsg = menu ? messages.find((m) => m.id === menu.id) : undefined;
  const menuMine = menuMsg?.sender_id === userId;

  return (
    <div className="chat">
      <div className="scroller" ref={scrollRef}>
        <div className="scroller-inner">
          {partnerTyping && <TypingBubble name={partnerName} />}
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

      {menu && menuMsg && canInteract(menuMsg) && (
        <MessageMenu
          anchor={menu.el}
          align={menuMine ? "end" : "start"}
          myEmoji={reactions[menuMsg.id]?.find((r) => r.user_id === userId)?.emoji}
          canCopy={!!menuMsg.body}
          canEdit={menuMine && !!menuMsg.body && !menuMsg.image_path}
          canUnsend={menuMine}
          autoFocus={menu.viaKeyboard}
          onReact={(emoji) => {
            closeMenu();
            react(menuMsg, emoji);
          }}
          onCopy={() => {
            closeMenu();
            navigator.clipboard?.writeText(menuMsg.body ?? "").catch(console.error);
          }}
          onEdit={() => {
            closeMenu();
            startEdit(menuMsg);
          }}
          onUnsend={() => {
            closeMenu();
            unsend(menuMsg);
          }}
          onClose={closeMenu}
        />
      )}

      {editing && (
        <div className="edit-banner">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
          </svg>
          <span>Editing message</span>
          <button
            className="edit-cancel"
            aria-label="Cancel editing"
            onPointerDown={(e) => e.preventDefault()}
            onClick={cancelEdit}
          >
            ✕
          </button>
        </div>
      )}

      <div className="composer">
        {!editing && (
          <button className="icon-btn attach" aria-label="Send a photo" onClick={() => fileRef.current?.click()}>
            <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
              <circle cx="12" cy="12.5" r="3.5" />
            </svg>
          </button>
        )}
        {/* No `capture` attribute: both iOS and Android then offer camera AND library in one picker */}
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          placeholder="Message"
          aria-label={editing ? "Edit message" : "Message"}
          enterKeyHint={editing ? "done" : "send"}
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={stopTyping}
        />
        <button
          className="send"
          aria-label={editing ? "Save edit" : "Send"}
          disabled={!text.trim()}
          // preventDefault on pointerdown keeps the textarea focused, so the keyboard stays up
          onPointerDown={(e) => e.preventDefault()}
          onClick={submit}
        >
          {editing ? (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12.5 4.5 4.5L19 7.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
              <path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
