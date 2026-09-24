import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "A ♥ A",
  description: "Just the two of us.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "A ♥ A", statusBarStyle: "default" },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content", // Android: keyboard shrinks the layout instead of covering it
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FDEEF4" },
    { media: "(prefers-color-scheme: dark)", color: "#10050B" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" href="/anton.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
