import { useEffect, useState, useCallback } from "react";

/**
 * Minimal hash router. We pick a single string like `'autobuild'` out of
 * `window.location.hash`. `#/autobuild` and `#autobuild` are both accepted
 * so old bookmarks don't break.
 *
 * Why hash instead of real router:
 *   - zero new deps
 *   - dev/prod parity without Vite rewrites
 *   - the rest of the app still uses a zustand view flag — layering a
 *     SPA router on top would force a rewrite of the phases view too
 *
 * Returns { route, setRoute } where route is '' (home) | 'autobuild' |
 * any future first-segment the caller decides to use.
 */
export function useHashRoute(): { route: string; setRoute: (next: string) => void } {
  const [route, setRouteState] = useState<string>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRouteState(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    // Also listen to popstate for the (rare) case where code calls history.back().
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, []);

  const setRoute = useCallback((next: string) => {
    const normalized = next ? `#/${next.replace(/^#?\/?/, "")}` : "";
    if (window.location.hash === normalized) return;
    // Use pushState when we have one already so back-button returns to the
    // previous view (phases ↔ autobuild feels bookmarkable).
    if (window.location.hash) {
      window.location.hash = normalized || "#/";
    } else {
      window.location.hash = normalized;
    }
    setRouteState(parseHash(normalized));
  }, []);

  return { route, setRoute };
}

/** Parse a hash fragment → first path segment. `#/autobuild` → `autobuild`. */
export function parseHash(hash: string): string {
  if (!hash) return "";
  const h = hash.replace(/^#\/?/, "");
  if (!h) return "";
  const first = h.split(/[/?#]/, 1)[0];
  return first ?? "";
}
