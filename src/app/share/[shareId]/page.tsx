import type { Metadata } from "next";
import { SharedTerminalSession } from "@/components/SharedTerminalSession";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shared SSH session — Sushi",
  description:
    "Join a team-shared Sushi SSH session: one live shell on the host, several people, same screen.",
  robots: { index: false, follow: false },
};

/**
 * `/share/<id>` — the link a teammate opens.
 *
 * Deliberately outside the signed-in workspace: the share code (or a Sushi session
 * cookie) is what authorises joining, so a teammate without an account can still land
 * straight in the shell instead of hitting the account gate first.
 */
export default async function SharedSessionPage({
  params,
}: {
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await params;
  return <SharedTerminalSession shareId={shareId} />;
}
