import { MutationObserver, onlineManager, QueryObserver } from '@tanstack/react-query';
import { queryClient } from './queryClient';

/**
 * No offline mode (ARCHITECTURE.md §6): while the browser says "offline",
 * requests still run and fail at once – nothing is queued for later – and what
 * failed loads again when the network is back.
 */
describe('queryClient without a network connection', () => {
  beforeEach(() => queryClient.mount());
  afterEach(() => {
    onlineManager.setOnline(true);
    queryClient.unmount();
    queryClient.clear();
  });

  it('runs a mutation at once and reports its failure (no paused mutation sent later)', async () => {
    onlineManager.setOnline(false);
    const send = vi.fn(() => Promise.reject(new Error('Failed to fetch')));
    const observer = new MutationObserver(queryClient, { mutationFn: send });
    await expect(observer.mutate()).rejects.toThrow('Failed to fetch');
    expect(send).toHaveBeenCalledOnce();
    expect(observer.getCurrentResult().isPaused).toBe(false);

    onlineManager.setOnline(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(send).toHaveBeenCalledOnce(); // nothing replayed after reconnecting
  });

  it('loads a query that failed while offline once the network is back', async () => {
    onlineManager.setOnline(false);
    let online = false;
    const load = vi.fn(() => (online ? Promise.resolve('daten') : Promise.reject(new Error('Failed to fetch'))));
    const observer = new QueryObserver(queryClient, { queryKey: ['test', 'reconnect'], queryFn: load, retry: false });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().status).toBe('error'));
    expect(load).toHaveBeenCalledOnce(); // sent although offline (not paused)

    online = true;
    onlineManager.setOnline(true);
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('daten'));
    unsubscribe();
  });
});
