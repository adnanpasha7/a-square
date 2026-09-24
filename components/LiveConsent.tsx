"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Her standing permission. Only the sharer ever sees this, and RLS only lets her write her own row.
export default function LiveConsent({
  sharerId,
  viewerName,
  onDisabled,
}: {
  sharerId: string;
  viewerName: string;
  onDisabled: () => void;
}) {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("live_consent")
      .select("allowed")
      .eq("sharer_id", sharerId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error(error);
        setAllowed(data?.allowed ?? false);
      });
  }, [sharerId]);

  async function toggle() {
    if (allowed === null) return;
    const next = !allowed;
    setError(null);
    setAllowed(next);
    // Turning it off ends any live session right away, before the database round trip
    if (!next) onDisabled();
    const { error } = await supabase
      .from("live_consent")
      .upsert({ sharer_id: sharerId, allowed: next, updated_at: new Date().toISOString() }, { onConflict: "sharer_id" });
    if (error) {
      console.error(error);
      setAllowed(!next);
      setError("Couldn't save that. Please try again.");
    }
  }

  return (
    <>
      <div className="sheet-row">
        <div>
          <h2 id="live-consent-label">Let {viewerName} see me live</h2>
          <p className="muted">
            When on, {viewerName} can start a live view without asking each time. You&apos;ll always see when he&apos;s
            watching, and you can turn this off anytime.
          </p>
        </div>
        <button
          className="switch"
          role="switch"
          aria-checked={allowed === true}
          aria-labelledby="live-consent-label"
          disabled={allowed === null}
          onClick={toggle}
        >
          <span />
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
