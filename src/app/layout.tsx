import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sushi — SSH, SFTP & RDP Remote Infrastructure Workspace",
  description:
    "Self-hosted VPS & Vercel-ready remote workspace for interactive SSH terminals, SFTP file management, and HTML5 RDP remote desktop sessions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="h-full overflow-hidden bg-[#090b10] text-slate-100 antialiased selection:bg-[#ff6b57]/30 selection:text-white">
        {children}
      </body>
    </html>
  );
}
