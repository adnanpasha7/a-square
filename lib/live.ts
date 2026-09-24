import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "./supabase";

// ============================================================
// Who is who. Fixed by identity, so it can't be flipped from the UI:
// the viewer can only ever watch the sharer, never the reverse.
// Put your real auth user ids here (Supabase → Authentication → Users → copy "User UID").
// ============================================================
export type LiveRole = "viewer" | "sharer";

export const LIVE_ROLES: Record<string, LiveRole> = {
  "7ba40c6b-4c1f-4186-b33d-a489d60de5a3": "viewer",
  "91ff927c-15ba-4e21-8def-9096b1f10403": "sharer",
};

const idWithRole = (role: LiveRole) => Object.keys(LIVE_ROLES).find((id) => LIVE_ROLES[id] === role) ?? null;
export const VIEWER_ID = idWithRole("viewer");
export const SHARER_ID = idWithRole("sharer");

export function liveRole(userId: string): LiveRole | null {
  return VIEWER_ID && SHARER_ID ? (LIVE_ROLES[userId] ?? null) : null;
}

// ---------- timings ----------
const PROMPT_MS = 30_000; // her Accept/Decline prompt
const VIEWER_WAIT_MS = 35_000; // how long I wait for her phone to answer at all
const CONNECT_MS = 30_000; // accept → video flowing
const DROP_GRACE_MS = 8_000; // "disconnected" this long counts as dropped
const RESTART_GRACE_MS = 15_000; // one ICE restart gets this long to recover
const ICE_FETCH_MS = 8_000;

// ---------- ICE servers ----------
const STUN_FALLBACK: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export async function fetchIceServers(): Promise<{ iceServers: RTCIceServer[]; turn: boolean }> {
  try {
    const call = supabase.functions.invoke<{ iceServers?: RTCIceServer[] }>("turn-credentials", { method: "POST" });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), ICE_FETCH_MS));
    const { data, error } = await Promise.race([call, timeout]);
    if (error) throw error;
    const iceServers = data?.iceServers ?? [];
    const turn = iceServers.some((s) => [s.urls].flat().some((u) => u.startsWith("turn")));
    if (!turn) throw new Error("no TURN servers returned");
    return { iceServers, turn };
  } catch (e) {
    console.warn("TURN unavailable, falling back to STUN only", e);
    return { iceServers: STUN_FALLBACK, turn: false };
  }
}

// ---------- camera (sharer only; video only, never audio) ----------
export type Facing = "user" | "environment";

export function getCamera(facing: Facing) {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new DOMException("No camera API", "NotFoundError"));
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    },
  });
}

function stopStream(s: MediaStream | null) {
  s?.getTracks().forEach((t) => t.stop());
}

export type LiveNote =
  | "no-answer"
  | "declined"
  | "expired"
  | "away"
  | "camera-unavailable"
  | "ended-by-peer"
  | "connection-lost"
  | "backgrounded"
  | "offline"
  | "camera-blocked"
  | "camera-missing"
  | "camera-busy"
  | "camera-error";

function cameraNote(e: unknown): LiveNote {
  const name = e instanceof DOMException || e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "camera-blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "camera-missing";
  if (name === "NotReadableError" || name === "AbortError") return "camera-busy";
  return "camera-error";
}

// ---------- state ----------
export type LivePhase =
  | "idle"
  | "asking" // viewer: request sent, she has to accept this one
  | "waiting" // viewer: she allowed it, waiting for her phone to start
  | "incoming" // sharer: Accept / Decline prompt
  | "connecting"
  | "live"
  | "ended"; // showing why it ended

export type LiveState = {
  phase: LivePhase;
  note: LiveNote | null;
  turnWarning: boolean;
  localStream: MediaStream | null; // sharer self-preview
  remoteStream: MediaStream | null; // viewer
  facing: Facing;
  expiresAt: number | null; // incoming prompt deadline
};

const INITIAL: LiveState = {
  phase: "idle",
  note: null,
  turnWarning: false,
  localStream: null,
  remoteStream: null,
  facing: "user",
  expiresAt: null,
};

type LiveEvent = "request" | "accept" | "decline" | "offer" | "answer" | "ice-candidate" | "end";
const EVENTS: LiveEvent[] = ["request", "accept", "decline", "offer", "answer", "ice-candidate", "end"];

type Signal = {
  sid: string;
  from: string;
  reason?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

const DECLINE_NOTES: Record<string, LiveNote> = {
  declined: "declined",
  expired: "expired",
  away: "away",
  camera: "camera-unavailable",
};

// ============================================================
// One controller per signed-in user. Signaling is ephemeral Realtime broadcast on a
// private channel; nothing about a session is written to the database or storage.
// ============================================================
class LiveController {
  state: LiveState = INITIAL;
  private channel: RealtimeChannel | null = null;
  private ready = false;
  private sid: string | null = null;
  private pc: RTCPeerConnection | null = null;
  private sender: RTCRtpSender | null = null;
  private ice: ReturnType<typeof fetchIceServers> | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private timers = new Map<string, number>();
  private restarted = false;
  private flipping = false;

  constructor(
    private userId: string,
    private role: LiveRole,
    private onChange: (s: LiveState) => void,
  ) {}

  private get peerId() {
    return this.role === "viewer" ? SHARER_ID : VIEWER_ID;
  }

  connect() {
    const ch = supabase.channel("live", { config: { private: true, broadcast: { self: false } } });
    for (const ev of EVENTS) ch.on("broadcast", { event: ev }, ({ payload }) => this.receive(ev, payload as Signal));
    ch.subscribe((status) => {
      this.ready = status === "SUBSCRIBED";
    });
    this.channel = ch;
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pagehide", this.onHidden);
  }

  dispose() {
    this.end(null);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pagehide", this.onHidden);
    if (this.channel) supabase.removeChannel(this.channel);
    this.channel = null;
  }

  // ---------- viewer ----------
  async start() {
    if (this.role !== "viewer" || this.sid) return;
    if (!this.ready) return this.set({ ...INITIAL, phase: "ended", note: "offline" });
    const sid = crypto.randomUUID();
    this.sid = sid;
    this.set({ ...INITIAL, phase: "waiting" });
    this.ice = fetchIceServers();

    const { data, error } = await supabase.from("live_consent").select("allowed").eq("sharer_id", SHARER_ID!).maybeSingle();
    if (error) console.error(error);
    if (this.sid !== sid) return;
    if (!data?.allowed) this.set({ phase: "asking" });
    this.send("request");
    this.timer("wait", VIEWER_WAIT_MS, () => this.end("no-answer"));
  }

  private async onAccept(sid: string) {
    this.clear("wait");
    this.set({ phase: "connecting" });
    this.timer("connect", CONNECT_MS, () => this.end("connection-lost"));
    const pc = await this.createPc(sid);
    if (!pc) return;
    // Receive only: this device's camera and mic are never touched
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (e) => this.set({ remoteStream: e.streams[0] ?? new MediaStream([e.track]) });
    await pc.setLocalDescription(await pc.createOffer());
    this.send("offer", { sdp: pc.localDescription?.toJSON() });
  }

  // ---------- sharer ----------
  private async onRequest(sid: string) {
    // A new request replaces anything stale from an old session
    if (this.sid) this.end(null);
    if (document.visibilityState !== "visible") return this.sendAs(sid, "decline", { reason: "away" });

    // Her own row decides. If it can't be read, fall back to asking.
    const { data, error } = await supabase.from("live_consent").select("allowed").eq("sharer_id", this.userId).maybeSingle();
    if (error) console.error(error);
    if (this.sid) return; // another request won the race
    this.sid = sid;
    this.ice = fetchIceServers();

    if (data?.allowed) return this.accept();
    this.set({ ...INITIAL, phase: "incoming", expiresAt: Date.now() + PROMPT_MS });
    this.timer("prompt", PROMPT_MS, () => this.decline("expired"));
  }

  async accept() {
    if (this.role !== "sharer" || !this.sid) return;
    const sid = this.sid;
    this.clear("prompt");
    this.set({ ...INITIAL, phase: "connecting" });

    let stream: MediaStream;
    try {
      stream = await getCamera("user");
    } catch (e) {
      console.error(e);
      this.send("decline", { reason: "camera" });
      this.teardown();
      return this.set({ ...INITIAL, phase: "ended", note: cameraNote(e) });
    }
    if (this.sid !== sid) return stopStream(stream); // ended while the camera was starting

    this.stream = stream;
    this.set({ localStream: stream, facing: "user" });
    this.acquireWakeLock();
    this.timer("connect", CONNECT_MS, () => this.end("connection-lost"));
    this.send("accept");
  }

  decline(reason: "declined" | "expired" | "away" = "declined") {
    if (this.role !== "sharer" || !this.sid) return;
    this.send("decline", { reason });
    this.teardown();
    this.set(INITIAL);
  }

  private async onOffer(sid: string, sdp: RTCSessionDescriptionInit) {
    const pc = this.pc ?? (await this.createPc(sid));
    if (!pc || this.sid !== sid) return;
    await pc.setRemoteDescription(sdp);
    if (!this.sender) {
      const t = pc.getTransceivers().find((x) => x.receiver.track.kind === "video");
      const track = this.stream?.getVideoTracks()[0];
      if (!t || !track) return this.end("camera-error");
      t.direction = "sendonly";
      await t.sender.replaceTrack(track);
      this.sender = t.sender;
    }
    await this.flushIce();
    await pc.setLocalDescription(await pc.createAnswer());
    this.send("answer", { sdp: pc.localDescription?.toJSON() });
  }

  async flip() {
    if (this.role !== "sharer" || !this.stream || this.flipping) return;
    this.flipping = true;
    const sid = this.sid;
    const current = this.state.facing;
    const next: Facing = current === "user" ? "environment" : "user";
    // iOS can't open a second camera while the first is running, so release it first
    stopStream(this.stream);
    try {
      await this.useStream(await getCamera(next), sid, next);
    } catch {
      try {
        await this.useStream(await getCamera(current), sid, current);
      } catch (e) {
        this.end(cameraNote(e));
      }
    } finally {
      this.flipping = false;
    }
  }

  private async useStream(stream: MediaStream, sid: string | null, facing: Facing) {
    if (!sid || this.sid !== sid) return stopStream(stream);
    this.stream = stream;
    await this.sender?.replaceTrack(stream.getVideoTracks()[0]);
    this.set({ localStream: stream, facing });
  }

  private async acquireWakeLock() {
    try {
      const lock = await navigator.wakeLock?.request("screen");
      if (!lock) return;
      if (this.sid) this.wakeLock = lock;
      else lock.release().catch(() => {});
    } catch {
      // not supported or refused: the session still works, the screen may just dim
    }
  }

  private capFrameRate() {
    const s = this.sender;
    if (!s) return;
    const params = s.getParameters();
    if (!params.encodings?.length) return;
    params.encodings[0].maxFramerate = 24;
    s.setParameters(params).catch(() => {});
  }

  // ---------- both ----------
  end(note: LiveNote | null, notify = true) {
    if (!this.sid && this.state.phase === "idle") return;
    if (notify) this.send("end");
    this.teardown();
    this.set({ ...INITIAL, phase: note ? "ended" : "idle", note });
  }

  dismiss() {
    if (this.state.phase === "ended") this.set(INITIAL);
  }

  private receive(event: LiveEvent, p: Signal) {
    if (!p || typeof p.sid !== "string" || !this.peerId || p.from !== this.peerId) return;
    if (event === "request") {
      if (this.role === "sharer") void this.onRequest(p.sid);
      return;
    }
    if (p.sid !== this.sid) return; // stale event from an old session
    const sid = p.sid;

    const run = async () => {
      switch (event) {
        case "accept":
          if (this.role === "viewer" && this.state.phase !== "connecting") await this.onAccept(sid);
          break;
        case "decline":
          if (this.role === "viewer") this.end(DECLINE_NOTES[p.reason ?? ""] ?? "declined", false);
          break;
        case "offer":
          if (this.role === "sharer" && p.sdp) await this.onOffer(sid, p.sdp);
          break;
        case "answer":
          if (this.role === "viewer" && p.sdp && this.pc) {
            await this.pc.setRemoteDescription(p.sdp);
            await this.flushIce();
          }
          break;
        case "ice-candidate":
          if (p.candidate) await this.addIce(p.candidate);
          break;
        case "end":
          this.end("ended-by-peer", false);
          break;
      }
    };
    run().catch((e) => {
      console.error(e);
      if (this.sid === sid) this.end("connection-lost");
    });
  }

  private async createPc(sid: string) {
    const { iceServers, turn } = await (this.ice ?? fetchIceServers());
    if (this.sid !== sid) return null;
    if (this.pc) return this.pc;
    if (!turn) this.set({ turnWarning: true });
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.onicecandidate = (e) => e.candidate && this.send("ice-candidate", { candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => this.onConnectionState(pc);
    return pc;
  }

  private onConnectionState(pc: RTCPeerConnection) {
    if (pc !== this.pc) return;
    switch (pc.connectionState) {
      case "connected":
        this.clear("connect");
        this.clear("drop");
        this.clear("restart");
        this.set({ phase: "live" });
        if (this.role === "sharer") this.capFrameRate();
        break;
      case "disconnected":
        this.timer("drop", DROP_GRACE_MS, () => this.onFailed(pc));
        break;
      case "failed":
        this.onFailed(pc);
        break;
      case "closed":
        this.end("connection-lost");
        break;
    }
  }

  // One ICE restart (the viewer re-offers), otherwise end cleanly
  private async onFailed(pc: RTCPeerConnection) {
    if (pc !== this.pc) return;
    this.clear("drop");
    if (this.restarted) return this.end("connection-lost");
    this.restarted = true;
    this.timer("restart", RESTART_GRACE_MS, () => this.end("connection-lost"));
    if (this.role !== "viewer") return;
    try {
      pc.restartIce();
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }));
      this.send("offer", { sdp: pc.localDescription?.toJSON() });
    } catch (e) {
      console.error(e);
      this.end("connection-lost");
    }
  }

  private async addIce(c: RTCIceCandidateInit) {
    if (this.pc?.remoteDescription) await this.pc.addIceCandidate(c).catch(console.error);
    else this.pendingIce.push(c);
  }

  private async flushIce() {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) await this.pc?.addIceCandidate(c).catch(console.error);
  }

  // Never keep the camera running in the background
  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.onHidden();
  };

  private onHidden = () => {
    if (!this.sid) return;
    if (this.state.phase === "incoming") this.decline("away");
    else this.end("backgrounded");
  };

  private teardown() {
    this.timers.forEach((t) => window.clearTimeout(t));
    this.timers.clear();
    stopStream(this.stream);
    this.stream = null;
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onconnectionstatechange = null;
      this.pc.getSenders().forEach((s) => s.track?.stop());
      this.pc.close();
      this.pc = null;
    }
    this.sender = null;
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.sid = null;
    this.ice = null;
    this.pendingIce = [];
    this.restarted = false;
  }

  private send(event: LiveEvent, extra: Omit<Signal, "sid" | "from"> = {}) {
    if (this.sid) this.sendAs(this.sid, event, extra);
  }

  private sendAs(sid: string, event: LiveEvent, extra: Omit<Signal, "sid" | "from"> = {}) {
    if (!this.channel || !this.ready) return;
    this.channel.send({ type: "broadcast", event, payload: { sid, from: this.userId, ...extra } }).catch(console.error);
  }

  private timer(name: string, ms: number, fn: () => void) {
    this.clear(name);
    this.timers.set(name, window.setTimeout(fn, ms));
  }

  private clear(name: string) {
    window.clearTimeout(this.timers.get(name));
    this.timers.delete(name);
  }

  private set(patch: Partial<LiveState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }
}

// ---------- React ----------
export type Live = LiveState & {
  role: LiveRole | null;
  start: () => void;
  accept: () => void;
  decline: () => void;
  end: () => void;
  flip: () => void;
  dismiss: () => void;
};

export function useLive(userId: string, role: LiveRole | null): Live {
  const [state, setState] = useState<LiveState>(INITIAL);
  const ref = useRef<LiveController | null>(null);

  useEffect(() => {
    if (!role) return;
    let alive = true;
    const c = new LiveController(userId, role, (s) => alive && setState(s));
    c.connect();
    ref.current = c;
    return () => {
      alive = false;
      c.dispose();
      ref.current = null;
      setState(INITIAL);
    };
  }, [userId, role]);

  const actions = useMemo(
    () => ({
      start: () => void ref.current?.start(),
      accept: () => void ref.current?.accept(),
      decline: () => ref.current?.decline(),
      end: () => ref.current?.end(null),
      flip: () => void ref.current?.flip(),
      dismiss: () => ref.current?.dismiss(),
    }),
    [],
  );

  return { ...state, role, ...actions };
}
