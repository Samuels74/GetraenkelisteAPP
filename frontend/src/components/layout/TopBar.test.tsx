import { onlineManager } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { useOnline } from '../../lib/useOnline';
import { TopBar } from './TopBar';

function Shell() {
  const online = useOnline();
  return <TopBar offline={!online} />;
}

afterEach(() => onlineManager.setOnline(true));

describe('TopBar', () => {
  it('shows "Keine Verbindung" while the browser is offline (TanStack onlineManager)', () => {
    render(<Shell />);
    expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();

    act(() => onlineManager.setOnline(false));
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Keine Verbindung');
    // announced, but never in the way of a tap
    expect(screen.getByRole('status')).toContainElement(screen.getByTestId('offline-banner'));

    act(() => onlineManager.setOnline(true));
    expect(screen.queryByTestId('offline-banner')).not.toBeInTheDocument();
  });
});
