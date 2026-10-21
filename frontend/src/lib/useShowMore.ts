/**
 * Long lists (Personen, Buchungen "Pro Person") render only their first
 * rows and append more on request ("Weitere 100 anzeigen"): mounting all 2000
 * persons at once froze phones for up to a second per keystroke, tab switch
 * and view switch (docs/LOADTEST-FINDINGS.md F1, F5). Everyone stays
 * reachable through the search or by showing more.
 */
import { useCallback, useState } from 'react';

/** Rows rendered at first and appended per "Weitere … anzeigen". */
export const LIST_PAGE_SIZE = 100;

/**
 * How many rows of a list to render. `showMore()` adds `pageSize` rows; the
 * limit starts over whenever `resetKey` changes (e.g. the search text or the
 * filter) – also when it returns to an earlier key (A → B → A starts at one
 * page again): the render that sees a new key replaces the state (React
 * re-runs just this component before committing). `initialLimit` restores
 * the rows a list showed before (e.g. Back to it), for its first key only.
 */
export function useShowMore(
  resetKey: string,
  pageSize = LIST_PAGE_SIZE,
  initialLimit = pageSize,
): { limit: number; showMore: () => void } {
  const [state, setState] = useState(() => ({ key: resetKey, limit: Math.max(pageSize, initialLimit) }));
  let current = state;
  if (state.key !== resetKey) {
    current = { key: resetKey, limit: pageSize };
    setState(current);
  }
  const showMore = useCallback(() => {
    setState((previous) => ({
      key: resetKey,
      limit: (previous.key === resetKey ? previous.limit : pageSize) + pageSize,
    }));
  }, [resetKey, pageSize]);
  return { limit: current.limit, showMore };
}
