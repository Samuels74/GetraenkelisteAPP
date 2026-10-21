/**
 * A text that lives in a URL search parameter (so back navigation, reloads
 * and links keep it) but is owned by local state while the page is mounted.
 *
 * Why not read and write the URL directly: every URL change is a router
 * navigation that re-renders the whole route tree – one per keystroke made
 * typing in the Personen search lag on phones (docs/LOADTEST-FINDINGS.md F1).
 * Here typing only updates the state; the URL follows `delayMs` after the
 * last change (replace, no new history entry).
 *
 * Navigation wins: every new location that is not this hook's own write –
 * back/forward, a link, also one to the same URL (the "Personen" tab clears
 * the search) – replaces the text and drops a pending write; no write starts
 * while a navigation is under way (it would abort that navigation). Only the
 * first location after an own write counts as that write, so going back to
 * an entry with the same text later restores it like any other.
 *
 * `flush()` writes a pending text at once: call it before navigating away
 * from the page (a tap on a result right after typing), so Back returns to
 * the search. When the page is left otherwise, a pending text is dropped –
 * the location has already changed by then.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigation, useSearchParams } from 'react-router';

export const SEARCH_PARAM_DELAY_MS = 400;

export function useSearchParamState(
  name: string,
  delayMs = SEARCH_PARAM_DELAY_MS,
): [value: string, setValue: (value: string) => void, flush: () => void] {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigating = useNavigation().state !== 'idle';
  const urlValue = params.get(name) ?? '';
  const [value, setValue] = useState(urlValue);
  // The location seen last, and the value of this hook's write that has not shown up yet.
  const [seenKey, setSeenKey] = useState(location.key);
  const [ownWrite, setOwnWrite] = useState<string | null>(null);
  if (location.key !== seenKey) {
    setSeenKey(location.key);
    setOwnWrite(null);
    // our own write keeps the text (the user may have typed on meanwhile); any other location shows its own
    if (ownWrite === null || urlValue !== ownWrite) setValue(urlValue);
  }

  // The pending write (null: none), for flush().
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (value === urlValue || navigating) return;
    let timer = 0;
    const write = () => {
      window.clearTimeout(timer);
      pending.current = null;
      setOwnWrite(value);
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value) next.set(name, value);
          else next.delete(name);
          return next;
        },
        { replace: true },
      );
    };
    timer = window.setTimeout(write, delayMs);
    pending.current = write;
    return () => {
      window.clearTimeout(timer);
      pending.current = null;
    };
  }, [value, urlValue, navigating, location.key, name, delayMs, setParams]);

  const flush = useCallback(() => pending.current?.(), []);
  return [value, setValue, flush];
}
