"use client";

import { useEffect, useState } from "react";

/** Tailwind's `md` breakpoint: below this the workspace is a phone/tablet layout. */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * Whether the viewport is phone-sized. `null` until the first client effect has run,
 * so a server-rendered/hydrated first paint never guesses a layout (and never flashes
 * the wrong screen): callers render the mobile layout only when this is `true`.
 */
export function useIsPhoneViewport(): boolean | null {
  const [isPhone, setIsPhone] = useState<boolean | null>(null);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
    const update = () => setIsPhone(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isPhone;
}

/**
 * On a phone (or an iOS/Android home-screen web app) the host list *is* the home
 * screen: search, protocol filter and every saved machine, one tap from a session.
 * A drawer is the wrong first thing to show there — it covers the hero, needs a
 * dismiss tap, and is what "Recently Connected must on top" was fighting with.
 *
 * The choice is remembered per browser so the hero can still be pinned as home if
 * someone prefers it, without asking again on every load.
 */
const MOBILE_HOME_KEY = "sushi_mobile_home_v1";

export type MobileHome = "hosts" | "launchpad";

function readStoredHome(): MobileHome {
  try {
    return localStorage.getItem(MOBILE_HOME_KEY) === "launchpad" ? "launchpad" : "hosts";
  } catch {
    return "hosts";
  }
}

export function useMobileHome(): [MobileHome, (home: MobileHome) => void] {
  const [home, setHome] = useState<MobileHome>("hosts");

  useEffect(() => {
    setHome(readStoredHome());
  }, []);

  const update = (next: MobileHome) => {
    setHome(next);
    try {
      localStorage.setItem(MOBILE_HOME_KEY, next);
    } catch {
      // best effort: the choice is a preference, not state worth failing over
    }
  };

  return [home, update];
}
