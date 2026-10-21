import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { useShowMore } from '../lib/useShowMore';
import { ShowMoreFooter } from './ShowMoreFooter';

/** A list of `total` link rows, `pageSize` per "Weitere … anzeigen". */
function List({ total, pageSize }: { total: number; pageSize: number }) {
  const { limit, showMore } = useShowMore('', pageSize);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = Math.min(limit, total);
  return (
    <>
      <ul ref={listRef}>
        {Array.from({ length: shown }, (_, i) => (
          <li key={i}>
            <a href={`#zeile-${i + 1}`}>Zeile {i + 1}</a>
          </li>
        ))}
      </ul>
      <ShowMoreFooter shown={shown} total={total} pageSize={pageSize} onShowMore={showMore} listRef={listRef} testId="more" />
    </>
  );
}

describe('ShowMoreFooter', () => {
  it('names how many come next – "1 weitere" for a single one', async () => {
    render(<List total={5} pageSize={2} />);
    expect(screen.getByTestId('more')).toHaveTextContent('2 von 5 Personen angezeigt');
    await userEvent.click(screen.getByRole('button', { name: 'Weitere 2 anzeigen' }));
    // the button stays (with the next number) and keeps the focus
    expect(screen.getByRole('button', { name: '1 weitere anzeigen' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: '1 weitere anzeigen' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByTestId('more')).not.toBeInTheDocument();
  });

  it('moves the focus to the first new row when the last rows remove the button', async () => {
    render(<List total={6} pageSize={2} />);
    await userEvent.click(screen.getByRole('button', { name: 'Weitere 2 anzeigen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Weitere 2 anzeigen' }));
    expect(screen.queryByTestId('more')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zeile 5' })).toHaveFocus();
  });
});
