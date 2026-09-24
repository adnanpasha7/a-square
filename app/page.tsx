"use client";

import dynamic from "next/dynamic";

// Everything here is browser-only (auth session, service worker, camera), so skip SSR entirely
const App = dynamic(() => import("@/components/App"), { ssr: false });

export default function Page() {
  return <App />;
}
