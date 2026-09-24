"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function LiveConsent({
  sharerId,
  viewerName,
  onDisabled,
}: {
  sharerId: string;
  viewerName: string;
  onDisabled: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function ensureConsent() {
      setError(null);

      const { error } = await supabase
        .from("live_consent")
        .upsert(
          {
            sharer_id: sharerId,
            allowed: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "sharer_id" }
        );

      if (error) {
        console.error(error);
        setError("Couldn't enable live viewing. Please try again.");
      }
    }

    ensureConsent();
  }, [sharerId]);

  return (
    <>
      <div className="sheet-row">
        <div>
          <h2 id="live-consent-label">
            Let {viewerName} see me live
          </h2>

          <p className="muted">
            {viewerName} can start a live view without asking each time.
            You&apos;ll always see when he&apos;s watching.
          </p>
        </div>

        <div
          className="switch"
          role="switch"
          aria-checked="true"
          aria-label="Live viewing enabled"
        >
          <span />
        </div>
      </div>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}