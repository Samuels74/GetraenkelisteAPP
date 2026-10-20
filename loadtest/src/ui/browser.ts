/**
 * Browser side of the UI checks: the two device profiles, a measured page
 * (UiPage) and the browser's lifecycle.
 *
 * - Profiles: "phone" = Playwright's Pixel 7 descriptor (412×839 viewport,
 *   DPR 2.625, touch) plus CDP Emulation.setCPUThrottlingRate 4× – set before
 *   the first navigation; "desktop" = Desktop Chrome (1280×720). Both with
 *   locale de-AT and time zone Europe/Vienna like the E2E suite, so the period
 *   filters match the seeder's local-time model.
 * - Authentication: the SDK auth store ("pocketbase_auth") and the selected
 *   person ("gl.selectedPersonId") are injected through storageState from the
 *   runner's one-time logins (ctx.logins) – never the login form, never extra
 *   API logins (the login rate limiter must not matter).
 * - Every context gets the in-page probe (page-probe.js) and, for cold loads, a
 *   per-context "load" watch armed at document start.
 * - Requests and transferred bytes come from a CDP Network session of the
 *   page (encodedDataLength = bytes on the wire); the realtime SSE stream is
 *   excluded from "in flight".
 * - Keystrokes are real key events for every character (CDP
 *   Input.dispatchKeyEvent with `text`), so the timer starts at the keydown's
 *   timestamp – also for "ü", which Playwright's keyboard.type() would insert
 *   as text without a keydown.
 * - Every measured interval is reported through `onTiming` (busy-machine check).
 * - Nothing here uses networkidle (the SSE stream never ends) or fixed sleeps
 *   as timing: waitQuiet() only paces the steps (network idle + no long task).
 * - Every call that talks to the browser is bounded: page.setDefaultTimeout,
 *   watch timeouts, and timeouts on closing pages and the browser (a wedged
 *   browser is killed).
 */
import { readdirSync, readFileSync } from 'node:fs';
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type CDPSession,
  type Locator,
  type Page,
} from '@playwright/test';
import type { Login } from '../perf/types.ts';
import {
  arm,
  idleSince,
  installProbe,
  longTasksBetween,
  result,
  summarizeLongTasks,
  type Conds,
  type LongTaskSummary,
  type WatchResult,
} from './probe.ts';

export type ProfileName = 'phone' | 'desktop';

export interface Profile {
  name: ProfileName;
  label: string;
  context: BrowserContextOptions;
  cpuThrottling: number;
}

function descriptor(name: string): BrowserContextOptions {
  const device = devices[name];
  if (!device) throw new Error(`Playwright has no device descriptor "${name}"`);
  const { defaultBrowserType: _ignored, ...options } = device;
  return options;
}

export const PROFILES: Record<ProfileName, Profile> = {
  phone: { name: 'phone', label: 'Pixel 7 emulation, 4× CPU throttling', context: descriptor('Pixel 7'), cpuThrottling: 4 },
  desktop: { name: 'desktop', label: 'Desktop Chrome 1280×720, no throttling', context: descriptor('Desktop Chrome'), cpuThrottling: 1 },
};

export interface NetworkProfile {
  label: string;
  latencyMs: number;
  downloadKbit: number;
  uploadKbit: number;
}

/** A busy bar Wi-Fi (Phase 1B §3). */
export const BAR_WIFI: NetworkProfile = {
  label: '5 Mbit/s down, 2 Mbit/s up, 50 ms RTT',
  latencyMs: 50,
  downloadKbit: 5000,
  uploadKbit: 2000,
};

/** Wall-clock time in ms with sub-ms resolution (comparable with the pages' timeOrigin + now). */
export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Rejects after `ms` (the pending operation keeps running – close its context to stop it). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what}: no result within ${Math.round(ms / 1000)} s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ requests

export interface RequestRecord {
  method: string;
  url: string;
  /** PERS, GRP, OFF, USR, TOT, LIST, RECENT, CSV, CREATE, DELETE, REFRESH, RT, RT-SUB, P-ONE, API, static */
  kind: string;
  api: boolean;
  /** The realtime SSE stream (never finishes). */
  sse: boolean;
  /** epoch ms (Node clock) */
  start: number;
  end?: number;
  /** Bytes on the wire (headers + body) once finished. */
  bytes: number;
}

/** Request types of Phase 1B §1.1 (the SPA's requests). */
export function classify(method: string, url: string): string {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return 'other';
  }
  const path = target.pathname;
  if (!path.startsWith('/api/')) return 'static';
  if (path === '/api/realtime') return method === 'GET' ? 'RT' : 'RT-SUB';
  if (path === '/api/app/totals') return 'TOT';
  if (path.endsWith('/auth-refresh')) return 'REFRESH';
  const match = /^\/api\/collections\/([^/]+)\/records(?:\/([^/]+))?$/.exec(path);
  if (!match) return 'API';
  const [, collection, id] = match;
  const perPage = target.searchParams.get('perPage');
  switch (collection) {
    case 'bookings':
      if (method === 'POST') return 'CREATE';
      if (method === 'DELETE') return 'DELETE';
      return perPage === '500' ? 'CSV' : perPage === '50' ? 'LIST' : 'RECENT';
    case 'persons':
      return method !== 'GET' ? 'P-WRITE' : id ? 'P-ONE' : 'PERS';
    case 'groups':
      return 'GRP';
    case 'offerings':
      return 'OFF';
    case 'users':
      return 'USR';
    default:
      return 'API';
  }
}

/** "PERS×3, TOT, REFRESH×2" */
export function describeKinds(records: readonly RequestRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.kind, (counts.get(record.kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => (n > 1 ? `${kind}×${n}` : kind)).join(', ');
}

// ------------------------------------------------------------------ keys

/** DOM key code and Windows virtual key code of a character (German layout for the umlauts). */
function keyCodes(char: string): { code: string; keyCode: number } {
  if (/^[a-z]$/i.test(char)) return { code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, keyCode: char.charCodeAt(0) };
  if (char === ' ') return { code: 'Space', keyCode: 32 };
  const german: Record<string, { code: string; keyCode: number }> = {
    ü: { code: 'BracketLeft', keyCode: 186 },
    ö: { code: 'Semicolon', keyCode: 192 },
    ä: { code: 'Quote', keyCode: 222 },
    ß: { code: 'Minus', keyCode: 219 },
  };
  return german[char.toLowerCase()] ?? { code: '', keyCode: 0 };
}

// ------------------------------------------------------------------ measured page

export interface OpenOptions {
  profile: ProfileName;
  login: Login;
  /** Record id of the person selected on the booking screen (localStorage gl.selectedPersonId). */
  selectedPersonId?: string;
  /** Arms the in-page watch 'load' at the start of every document (cold load / reload). */
  load?: { conds: Conds; timeoutMs?: number };
  network?: NetworkProfile;
}

export interface Measurement extends WatchResult {
  /** Start of the action: the input event's timestamp, else the arm time (page clock). */
  start: number;
}

export interface MeasureOptions {
  timeoutMs?: number;
  /** Accept conditions that were already true before the action (default: error). */
  allowStale?: boolean;
  /** What this timing is, for the busy-machine check ('' = not a reported timing). */
  label?: string;
}

const DEFAULT_WATCH_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 15_000;

export class UiPage {
  readonly requests: RequestRecord[] = [];
  /** Ids of bookings this page created (POST responses) – for the cleanup. */
  readonly createdBookings: string[] = [];
  readonly errors: string[] = [];
  /** Steps that started although the page had not settled (waitQuiet gave up). */
  readonly warnings: string[] = [];
  crashed = false;
  /** performance.timeOrigin (epoch ms) of the current document. */
  origin = 0;
  /** Receives every measured interval (epoch ms) – set by the scenario environment. */
  onTiming: ((label: string, from: number, to: number) => void) | null = null;
  private readonly byId = new Map<string, RequestRecord>();
  private lastActivity = epochNow();
  private closing: Promise<boolean> | null = null;
  private tracing = false;

  readonly profile: Profile;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly cdp: CDPSession;

  private constructor(profile: Profile, context: BrowserContext, page: Page, cdp: CDPSession) {
    this.profile = profile;
    this.context = context;
    this.page = page;
    this.cdp = cdp;
  }

  static async open(browser: Browser, url: string, options: OpenOptions): Promise<UiPage> {
    const profile = PROFILES[options.profile];
    const origin = new URL(url).origin;
    const localStorage = [
      { name: 'pocketbase_auth', value: JSON.stringify({ token: options.login.token, record: options.login.record }) },
    ];
    if (options.selectedPersonId) localStorage.push({ name: 'gl.selectedPersonId', value: options.selectedPersonId });
    const context = await browser.newContext({
      ...profile.context,
      locale: 'de-AT',
      timezoneId: 'Europe/Vienna',
      baseURL: url,
      acceptDownloads: true,
      serviceWorkers: 'block',
      storageState: { cookies: [], origins: [{ origin, localStorage }] },
    });
    try {
      await installProbe(
        context,
        origin,
        options.load ? { conds: options.load.conds, timeoutMs: options.load.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS } : undefined,
      );
      const page = await context.newPage();
      page.setDefaultTimeout(30_000);
      page.setDefaultNavigationTimeout(60_000);
      const cdp = await context.newCDPSession(page);
      const ui = new UiPage(profile, context, page, cdp);
      ui.listen();
      // before the first navigation, so the app starts on the slow CPU / network
      if (profile.cpuThrottling > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottling });
      await cdp.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 });
      if (options.network) {
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: options.network.latencyMs,
          downloadThroughput: (options.network.downloadKbit * 1000) / 8,
          uploadThroughput: (options.network.uploadKbit * 1000) / 8,
        });
      }
      return ui;
    } catch (error) {
      await withTimeout(context.close(), CLOSE_TIMEOUT_MS, 'closing a browser context').catch(() => undefined);
      throw error;
    }
  }

  private listen(): void {
    this.cdp.on('Network.requestWillBeSent', (event) => {
      if (event.redirectResponse) return; // same request, next hop
      const { url, method } = event.request;
      if (!/^https?:/.test(url)) return;
      const kind = classify(method, url);
      const record: RequestRecord = {
        method,
        url,
        kind,
        api: kind !== 'static' && kind !== 'other',
        sse: event.type === 'EventSource' || kind === 'RT',
        start: epochNow(),
        bytes: 0,
      };
      this.byId.set(event.requestId, record);
      this.requests.push(record);
      this.lastActivity = record.start;
    });
    this.cdp.on('Network.loadingFinished', (event) => {
      const record = this.byId.get(event.requestId);
      if (!record) return;
      record.end = epochNow();
      record.bytes = event.encodedDataLength;
      this.lastActivity = record.end;
    });
    this.cdp.on('Network.loadingFailed', (event) => {
      const record = this.byId.get(event.requestId);
      if (!record) return;
      record.end = epochNow();
      this.lastActivity = record.end;
    });
    this.page.on('pageerror', (error) => this.errors.push(`page error: ${error.message}`));
    this.page.on('crash', () => {
      this.crashed = true;
      this.errors.push('the page crashed (renderer process gone – out of memory?)');
    });
    this.page.on('response', (response) => {
      const request = response.request();
      if (request.method() !== 'POST' || !/\/api\/collections\/bookings\/records(\?|$)/.test(response.url())) return;
      if (!response.ok()) return;
      response
        .json()
        .then((body: { id?: string }) => {
          if (body.id) this.createdBookings.push(body.id);
        })
        .catch(() => undefined);
    });
  }

  private report(label: string, from: number, to: number): void {
    if (label) this.onTiming?.(label, from, to);
  }

  /** Taps on the phone (touch), clicks on the desktop. */
  async press(locator: Locator): Promise<void> {
    if (this.profile.name === 'phone') await locator.tap();
    else await locator.click();
  }

  /**
   * One real key press (keydown with the character, keyup) for any character,
   * also outside Playwright's US layout: the keydown carries the browser's
   * receive time, so a busy main thread counts.
   */
  async typeChar(char: string): Promise<void> {
    const { code, keyCode } = keyCodes(char);
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: char,
      code,
      windowsVirtualKeyCode: keyCode,
      text: char,
      unmodifiedText: char,
    });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char, code, windowsVirtualKeyCode: keyCode });
  }

  /** Navigates and waits for the per-context 'load' watch (cold load: fresh context). */
  async load(path: string, options: { timeoutMs?: number; label?: string } = {}): Promise<WatchResult> {
    await this.page.goto(path, { waitUntil: 'commit' });
    return this.loadResult(options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS, options.label ?? `load ${path}`);
  }

  /** Reload of the current document (warm: assets from the HTTP cache). */
  async reload(options: { timeoutMs?: number; label?: string } = {}): Promise<WatchResult> {
    await this.page.reload({ waitUntil: 'commit' });
    return this.loadResult(options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS, options.label ?? 'reload');
  }

  private async loadResult(timeoutMs: number, label: string): Promise<WatchResult> {
    let watch: WatchResult | null = null;
    for (let attempt = 0; watch === null; attempt++) {
      try {
        watch = await withTimeout(result(this.page, 'load'), timeoutMs + 10_000, 'page load');
      } catch (error) {
        // right after the commit the new document may not be ready for evaluate() yet
        if (attempt >= 20 || this.crashed || !/no watch|Execution context|not installed/i.test(String(error))) throw error;
        await sleep(50);
      }
    }
    this.origin = watch.origin;
    assertWatch(watch, 'page load');
    this.report(label, watch.origin, watch.origin + lastPaint(watch));
    return watch;
  }

  /** Arms named conditions, runs the action (a tap, a key press …) and waits until all of them painted. */
  async measure(conds: Conds, action: () => Promise<unknown>, options: MeasureOptions = {}): Promise<Measurement> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
    const id = await arm(this.page, conds, timeoutMs);
    await action();
    const watch = await withTimeout(result(this.page, id), timeoutMs + 10_000, 'measurement');
    this.origin = watch.origin;
    assertWatch(watch, 'measurement', options.allowStale);
    const start = watch.input?.ts ?? watch.armAt;
    this.report(options.label ?? Object.keys(conds).join('+'), watch.origin + start, watch.origin + Math.max(start, lastPaint(watch)));
    return { ...watch, start };
  }

  /** Arms conditions without an action of this page (the change comes from elsewhere). */
  async watch(conds: Conds, options: { timeoutMs?: number; label?: string } = {}): Promise<() => Promise<WatchResult>> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
    const id = await arm(this.page, conds, timeoutMs);
    return async () => {
      const watch = await withTimeout(result(this.page, id), timeoutMs + 10_000, 'watch');
      this.origin = watch.origin;
      assertWatch(watch, 'watch');
      this.report(options.label ?? Object.keys(conds).join('+'), watch.origin + watch.armAt, watch.origin + lastPaint(watch));
      return watch;
    };
  }

  /** Requests still running (the SSE stream and requests older than 20 s excluded). */
  inflight(): number {
    const now = epochNow();
    return this.requests.filter((r) => !r.sse && r.end === undefined && now - r.start < 20_000).length;
  }

  /**
   * Waits until the page is idle: no request in flight and no long task for
   * `quietMs`. Paces the steps of a scenario (it is never a timing itself).
   * If the page does not settle within `maxMs`, the next step starts anyway
   * and a warning is recorded (it ends up as a note of the result).
   */
  async waitQuiet(options: { quietMs?: number; maxMs?: number; before?: string } = {}): Promise<boolean> {
    const quietMs = options.quietMs ?? 300;
    const maxMs = options.maxMs ?? 8000;
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (this.crashed) throw new Error('the page crashed');
      if (this.inflight() === 0 && epochNow() - this.lastActivity >= quietMs) {
        const { now, lastEnd } = await idleSince(this.page);
        if (now - lastEnd >= quietMs) return true;
      }
      if (Date.now() > deadline) {
        this.warnings.push(
          `the ${this.profile.name} page did not settle within ${Math.round(maxMs / 1000)} s` +
            `${options.before ? ` before ${options.before}` : ''} (requests or long tasks still running) – the next timing started on a busy page`,
        );
        return false;
      }
      await sleep(40);
    }
  }

  /** Requests started at or after `fromEpoch` (and before `toEpoch`). */
  requestsBetween(fromEpoch: number, toEpoch = Infinity): RequestRecord[] {
    return this.requests.filter((r) => r.start >= fromEpoch && r.start < toEpoch);
  }

  async longTasks(from: number, to: number): Promise<LongTaskSummary> {
    return summarizeLongTasks(await longTasksBetween(this.page, from, to));
  }

  /** Used JS heap after a full garbage collection (bytes). */
  async heapAfterGc(): Promise<number> {
    await this.cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await this.cdp.send('Runtime.getHeapUsage');
    return usedSize;
  }

  /** Records a Chromium performance trace (with screenshots) of this page into `path`. */
  async startTrace(path: string): Promise<void> {
    const browser = this.context.browser();
    if (!browser) return;
    await browser.startTracing(this.page, { path, screenshots: true });
    this.tracing = true;
  }

  async stopTrace(): Promise<void> {
    if (!this.tracing) return;
    this.tracing = false;
    await this.context.browser()?.stopTracing();
  }

  /** Closes the context; false if the browser did not answer within 15 s (then it is wedged). */
  close(): Promise<boolean> {
    this.closing ??= (async () => {
      await withTimeout(this.stopTrace(), CLOSE_TIMEOUT_MS, 'stopping a trace').catch(() => undefined);
      return withTimeout(this.context.close(), CLOSE_TIMEOUT_MS, 'closing a browser context').then(
        () => true,
        () => false,
      );
    })();
    return this.closing;
  }
}

/** The latest paint time of a watch's conditions (page clock). */
function lastPaint(watch: WatchResult): number {
  let last = watch.armAt;
  for (const mark of Object.values(watch.keys)) if (mark?.paintedAt) last = Math.max(last, mark.paintedAt);
  return last;
}

/** Throws for timeouts, condition errors and (unless allowed) conditions that were true before the action. */
function assertWatch(watch: WatchResult, what: string, allowStale = false): void {
  if (watch.error) throw new Error(`${what}: a condition failed in the page: ${watch.error}`);
  if (watch.timedOut) {
    throw new Error(`${what}: the expected content did not appear (still waiting for: ${watch.pending.join(', ') || '?'})`);
  }
  if (!allowStale) {
    const stale = Object.entries(watch.keys)
      .filter(([, mark]) => mark?.stale)
      .map(([key]) => key);
    if (stale.length > 0) {
      throw new Error(`${what}: "${stale.join('", "')}" was already shown before the action – the measurement would time old content`);
    }
  }
}

/** Painted time of a condition (page clock), or a clear error. */
export function paintedAt(watch: WatchResult, key: string): number {
  const mark = watch.keys[key];
  if (!mark || mark.paintedAt === null) throw new Error(`condition "${key}" has no paint time`);
  return mark.paintedAt;
}

// ------------------------------------------------------------------ browser lifecycle

/** Child processes of this process (Linux), for finding the browser Playwright launched. */
function childPids(): Set<number> {
  const pids = new Set<number>();
  if (process.platform !== 'linux') return pids;
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === process.pid) pids.add(Number(entry));
      } catch {
        // exited meanwhile
      }
    }
  } catch {
    // no /proc
  }
  return pids;
}

const BROWSER_CLOSE_TIMEOUT_MS = 20_000;

/**
 * Launches Chromium (headless shell, the build of the installed Playwright –
 * no downloads) on demand and again after a crash, so one dead browser fails
 * one scenario, not the rest.
 *
 * Playwright's own SIGINT/SIGTERM/SIGHUP handlers are off: they would close
 * the browser and call process.exit(130) before the host (runner / CLI) could
 * stop its PocketBase and write its report. The host owns shutdown;
 * Playwright's 'exit' hook still kills the browser when the process ends. A
 * browser that does not close within 20 s is killed (its process group).
 */
export class BrowserHolder {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private pid: number | null = null;
  private finished = false;
  /** Set when the browser went away while it was in use. */
  disconnects = 0;

  async get(): Promise<Browser> {
    if (this.finished) throw new Error('the browser checks were stopped');
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= (async () => {
      const before = childPids();
      const browser = await chromium.launch({
        headless: true,
        timeout: 60_000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      this.pid = [...childPids()].find((pid) => !before.has(pid) && isBrowserProcess(pid)) ?? null;
      this.browser = browser;
      browser.on('disconnected', () => {
        if (this.browser === browser) {
          this.browser = null;
          this.disconnects += 1;
        }
      });
      if (this.finished) {
        await this.close(true);
        throw new Error('the browser checks were stopped');
      }
      return browser;
    })().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  version(): string | null {
    return this.browser?.version() ?? null;
  }

  /**
   * Closes the browser (Playwright then removes its temp profile and artifacts
   * dirs); kills it if it does not close within 20 s. `final` also prevents a
   * relaunch (stop / end of the run).
   */
  async close(final = false): Promise<void> {
    if (final) this.finished = true;
    const browser = this.browser ?? (await this.launching?.catch(() => null)) ?? null;
    this.browser = null;
    if (!browser) return;
    const closed = await withTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'closing the browser').then(
      () => true,
      () => false,
    );
    if (!closed) this.kill();
  }

  /** Kills the browser's process group (Linux; Playwright starts it as a group leader). */
  kill(): void {
    const pid = this.pid;
    this.pid = null;
    this.browser = null;
    if (pid === null) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

function isBrowserProcess(pid: number): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /chrom|headless_shell/i.test(cmdline) && cmdline.includes('remote-debugging-pipe');
  } catch {
    return false;
  }
}
