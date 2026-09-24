"use client";

import { useEffect, useState } from "react";
import type { Message } from "@/lib/supabase";
import { signOne } from "@/lib/signed-urls";
import { dayLabel, timeLabel } from "@/lib/dates";

export default function Lightbox({ message, onClose }: { message: Message; onClose: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [full, setFull] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (message.thumb_path) signOne(message.thumb_path).then((u) => alive && setThumb(u));
    if (message.image_path) signOne(message.image_path).then((u) => alive && setFull(u));
    return () => { alive = false; };
  }, [message]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="lightbox" role="dialog" aria-label="Photo" onClick={onClose}>
      <button className="lightbox-close" aria-label="Close" onClick={onClose}>✕</button>
      {/* Thumbnail shows instantly, full-res swaps in when it's loaded */}
      {(full || thumb) && (
        <img src={full ?? thumb!} alt="" onClick={(e) => e.stopPropagation()} />
      )}
      <p className="lightbox-meta">
        {dayLabel(message.created_at)}, {timeLabel(message.created_at)}
        <br />
        Press and hold the photo to save it
      </p>
    </div>
  );
}
