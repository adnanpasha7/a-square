"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase, type Message } from "@/lib/supabase";
import { signMany } from "@/lib/signed-urls";

const PAGE = 60;

function monthLabel(iso: string) {
  const d = new Date(iso);
  return {
    key: `${d.getFullYear()}-${d.getMonth()}`,
    month: d.toLocaleDateString(undefined, { month: "long" }),
    year: String(d.getFullYear()),
  };
}

export default function Gallery({ onOpenImage }: { onOpenImage: (m: Message) => void }) {
  const [photos, setPhotos] = useState<Message[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (before?: string) => {
    setLoading(true);
    let q = supabase
      .from("messages")
      .select("*")
      .not("image_path", "is", null)
      .order("created_at", { ascending: false })
      .limit(PAGE);
    if (before) q = q.lt("created_at", before);
    const { data, error } = await q;
    setLoading(false);
    if (error) return console.error(error);

    setPhotos((prev) => (before ? [...prev, ...data] : data));
    setHasMore(data.length === PAGE);
    const signed = await signMany(data.map((m) => m.thumb_path!).filter(Boolean));
    setUrls((u) => ({ ...u, ...signed }));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!loading && photos.length === 0) {
    return <p className="empty">Every photo you send each other lands here, like a little album of the two of you.</p>;
  }

  // Group by month
  const groups: { label: ReturnType<typeof monthLabel>; items: Message[] }[] = [];
  for (const p of photos) {
    const label = monthLabel(p.created_at);
    const last = groups[groups.length - 1];
    if (last?.label.key === label.key) last.items.push(p);
    else groups.push({ label, items: [p] });
  }

  return (
    <div className="gallery">
      {groups.map((g) => (
        <section key={g.label.key}>
          {/* month solid, year outlined, same split as the wordmark */}
          <h2 className="month">
            {g.label.month} <span className="outline">{g.label.year}</span>
          </h2>
          <div className="grid">
            {g.items.map((p) => (
              <button key={p.id} className="tile" onClick={() => onOpenImage(p)} aria-label="Open photo">
                {p.thumb_path && urls[p.thumb_path] && (
                  <img src={urls[p.thumb_path]} alt="" loading="lazy" decoding="async" />
                )}
              </button>
            ))}
          </div>
        </section>
      ))}
      {hasMore && (
        <button className="load-older" onClick={() => load(photos[photos.length - 1].created_at)} disabled={loading}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
