import type { Metadata, Viewport } from "next";
import BuildUpdateBanner from "@/components/BuildUpdateBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sushi — SSH, SFTP & RDP Remote Infrastructure Workspace",
  description:
    "Self-hosted VPS & Vercel-ready remote workspace for interactive SSH terminals, SFTP file management, and HTML5 RDP remote desktop sessions.",
  applicationName: "Sushi",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/sushi-icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Sushi",
    statusBarStyle: "black-translucent",
  },
  // Next emits the generic mobile-web-app-capable tag; older iOS needs this one.
  other: { "apple-mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090b10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="app-safe-area h-[100dvh] overflow-hidden bg-[#090b10] text-slate-100 antialiased selection:bg-[#ff6b57]/30 selection:text-white">
        {children}
        <BuildUpdateBanner />
      </body>
    </html>
  );
}
