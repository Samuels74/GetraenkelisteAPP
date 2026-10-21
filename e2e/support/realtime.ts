import { expect, type Page, type Request } from '@playwright/test';

/**
 * Lets only realtime events of these collections reach the page (the
 * subscription request is rewritten). Parallel tests create users, persons,
 * groups and offerings all the time; their events make the page refetch –
 * offering and group events even every booking query, by design – which would
 * hide what a test is about. `[]`: no events at all (only PB_CONNECT).
 */
export async function subscribeOnly(page: Page, collections: readonly string[]): Promise<void> {
  await page.route('**/api/realtime', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    const body = request.postDataJSON() as { subscriptions?: string[] };
    const subscriptions = (body.subscriptions ?? []).filter(
      (topic) => topic === 'PB_CONNECT' || collections.some((collection) => topic.startsWith(`${collection}/`)),
    );
    return route.continue({ postData: JSON.stringify({ ...body, subscriptions }) });
  });
}

/** Every API request but the realtime stream. */
function isApiRequest(request: Request): boolean {
  return request.url().includes('/api/') && !(request.method() === 'GET' && new URL(request.url()).pathname === '/api/realtime');
}

/**
 * Call before the page loads; the returned function resolves once realtime is
 * connected and the refetch of its first connect has answered: queries that
 * settled before the subscriptions were active are loaded once more (FLOW-5),
 * and such a late answer could count as a reload, or already contain what the
 * test does next. "Answered": none of the `requests` (default: every API
 * request but the realtime stream) under way for half a second – a page that
 * gets person / user events of parallel tests reloads the persons all the
 * time, so it names the requests that matter to it.
 */
export function realtimeSettled(page: Page, requests: (request: Request) => boolean = isApiRequest): () => Promise<void> {
  let pending = 0;
  let changed = Date.now();
  const counts = (request: Request) => isApiRequest(request) && requests(request);
  const update = (delta: number) => (request: Request) => {
    if (!counts(request)) return;
    pending += delta;
    changed = Date.now();
  };
  page.on('request', update(1));
  page.on('requestfinished', update(-1));
  page.on('requestfailed', update(-1));
  const subscribed = page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/realtime',
  );
  return async () => {
    await subscribed;
    await expect.poll(() => pending === 0 && Date.now() - changed > 500).toBe(true);
  };
}
