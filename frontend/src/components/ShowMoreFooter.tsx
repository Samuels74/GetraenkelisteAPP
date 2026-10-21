import type { RefObject } from 'react';
import { flushSync } from 'react-dom';
import { formatCount } from '../lib/money';
import { LIST_PAGE_SIZE } from '../lib/useShowMore';
import { Button } from './ui/Button';

/** The row's link or button – or the row itself. */
function focusRow(row: Element | undefined): void {
  const target = row?.matches('a[href], button') ? row : row?.querySelector('a[href], button');
  if (target instanceof HTMLElement) target.focus({ preventScroll: true });
}

/**
 * Below a list that renders only its first rows (see useShowMore):
 * "100 von 2000 Personen angezeigt" and a button for the next rows.
 * Renders nothing once every row is shown – the tap that shows the last rows
 * removes the focused button, so focus moves on to the first new row of
 * `listRef` (keyboard and screen-reader users keep their place).
 */
export function ShowMoreFooter({
  shown,
  total,
  pageSize = LIST_PAGE_SIZE,
  onShowMore,
  listRef,
  testId,
}: {
  shown: number;
  total: number;
  pageSize?: number;
  onShowMore: () => void;
  /** The list whose children are the rows. */
  listRef?: RefObject<HTMLElement | null>;
  testId?: string;
}) {
  if (shown >= total) return null;
  const next = Math.min(pageSize, total - shown);

  function showMore() {
    const list = listRef?.current;
    if (shown + next < total || !list) {
      onShowMore();
      return;
    }
    flushSync(onShowMore); // the new rows are in the DOM now, this footer is gone
    focusRow(list.children[shown]);
  }

  return (
    <div className="mt-3 space-y-2 text-center" data-testid={testId}>
      <p className="text-sm text-muted" role="status">
        {formatCount(shown)} von {formatCount(total)} Personen angezeigt
      </p>
      <Button block onClick={showMore}>
        {next === 1 ? '1 weitere anzeigen' : `Weitere ${next} anzeigen`}
      </Button>
    </div>
  );
}
