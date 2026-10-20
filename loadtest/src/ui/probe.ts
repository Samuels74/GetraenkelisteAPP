/**
 * Contract of the in-page instrumentation and its typed Node side.
 *
 * page-probe.js runs in the page (a classic script installed with addInitScript)
 * and is type-checked against the types below (`// @ts-check` + JSDoc; the
 * tsconfig includes that one JS file) – the condition language, the watch
 * results, the buffers and the in-page API are declared once, here.
 *
 * The functions passed to page.evaluate() are serialized by Playwright and run
 * in the page, so they must not reference anything from this module – only
 * `globalThis.__lt` (the type assertions are erased).
 */
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';

/** Source of page-probe.js – installed with addInitScript() into every measured context. */
export const PROBE_SOURCE = readFileSync(new URL('./page-probe.js', import.meta.url), 'utf8');

/** Checks on `document.querySelector(sel)` (list checks use querySelectorAll – small lists only). */
export interface SelCond {
  sel: string;
  absent?: true;
  children?: number;
  text?: string;
  contains?: string;
  attr?: [string, string];
  count?: number;
  min?: number;
  anyContains?: string;
  countContains?: [string, number];
  /**
   * The element (for anyContains: one of the matching elements) must be visibly
   * painted: rendered, not visibility:hidden and an effective opacity of at
   * least 0.5 – for elements that fade in (toasts, the picker dialog).
   */
  visible?: true;
}

/** A JSON condition evaluated in the page (see page-probe.js check()). */
export type Cond =
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond }
  | { path: string }
  | { param: [string, string | null] }
  | { blob: true }
  | { input: true }
  | SelCond;

/** Named conditions of one watch, e.g. { toast: …, total: … }. */
export type Conds = Record<string, Cond>;

export interface Mark {
  /** performance.now() of the frame in which the condition was first true. */
  satisfiedAt: number;
  /** performance.now() of the first task after that frame was rendered. */
  paintedAt: number | null;
  /** The condition was already true when the watch was armed. */
  stale: boolean;
}

export interface WatchResult {
  id: string;
  armAt: number;
  doneAt: number;
  timedOut: boolean;
  /** A condition threw (e.g. an invalid selector). */
  error: string | null;
  /** performance.timeOrigin of the document (epoch ms) – converts page times to wall-clock time. */
  origin: number;
  /** The earliest input event after arming (timeStamp = when the browser received it). */
  input: { type: string; ts: number; trusted: boolean } | null;
  /** The frame after the input events of that action had been handled. */
  inputPaint: number | null;
  keys: Record<string, Mark | null>;
  /** Conditions that never became true (timeout). */
  pending: string[];
}

/** [startTime, duration] */
export type LongTask = [number, number];
/** [name, startTime, processingStart, processingEnd, duration, interactionId] */
export type EventEntry = [string, number, number, number, number, number];

/** page-probe.js: a user input event seen in the capture phase, with the time of the frame after it. */
export interface ProbeInput {
  type: string;
  /** event.timeStamp */
  ts: number;
  /** performance.now() when the listener ran */
  at: number;
  trusted: boolean;
  paint: number | null;
}

/** page-probe.js: an armed watch. */
export interface ProbeWatch {
  id: string;
  armAt: number;
  deadline: number;
  conds: Conds;
  pending: Map<string, Cond>;
  keys: Record<string, Mark>;
  error: string | null;
  timer: number;
  /** A pending condition needs a check in every frame (visibility changes without DOM mutations). */
  everyFrame: boolean;
  /** Attribute names the conditions depend on (MutationObserver attributeFilter). */
  attributes: string[];
}

/** The in-page API (window.__lt). */
export interface ProbeApi {
  arm(conds: Conds, timeoutMs: number): string;
  /** Arms the watch 'load' – called by a per-context init script at document start. */
  armLoad(conds: Conds, timeoutMs: number): string;
  result(id: string): Promise<WatchResult | null>;
  longTasksBetween(from: number, to: number): LongTask[];
  eventsBetween(from: number, to: number): EventEntry[];
  /** performance.now() and the end of the last long task. */
  idleSince(): { now: number; lastEnd: number };
  /** CPU calibration: a fixed amount of JS work, in ms. */
  bench(iterations: number): number;
  /** Number of elements in the document. */
  elements(): number;
}

type ProbeGlobal = { __lt?: ProbeApi };

/**
 * Arms the watch 'load' at the start of every document of this context (cold
 * loads and reloads), so a load is measured from navigation start no matter
 * when Node gets to ask. Only on `origin` (not on about:blank).
 */
export async function installProbe(context: BrowserContext, origin: string, load?: { conds: Conds; timeoutMs: number }) {
  await context.addInitScript({ content: PROBE_SOURCE });
  if (load) {
    const conds = JSON.stringify(load.conds);
    await context.addInitScript({
      content: `if (location.origin === ${JSON.stringify(origin)} && window.__lt) window.__lt.armLoad(${conds}, ${load.timeoutMs});`,
    });
  }
}

export function arm(page: Page, conds: Conds, timeoutMs: number): Promise<string> {
  return page.evaluate(
    ([c, t]) => {
      const lt = (globalThis as unknown as ProbeGlobal).__lt;
      if (!lt) throw new Error('probe not installed in this page');
      return lt.arm(c, t);
    },
    [conds, timeoutMs] as const,
  );
}

export async function result(page: Page, id: string): Promise<WatchResult> {
  const value = await page.evaluate((watchId) => {
    const lt = (globalThis as unknown as ProbeGlobal).__lt;
    return lt ? lt.result(watchId) : null;
  }, id);
  if (!value) throw new Error(`no watch "${id}" in the page (probe missing or the page navigated away)`);
  return value;
}

export function longTasksBetween(page: Page, from: number, to: number): Promise<LongTask[]> {
  return page.evaluate(([a, b]) => (globalThis as unknown as ProbeGlobal).__lt?.longTasksBetween(a, b) ?? [], [from, to] as const);
}

export function eventsBetween(page: Page, from: number, to: number): Promise<EventEntry[]> {
  return page.evaluate(([a, b]) => (globalThis as unknown as ProbeGlobal).__lt?.eventsBetween(a, b) ?? [], [from, to] as const);
}

export function idleSince(page: Page): Promise<{ now: number; lastEnd: number }> {
  return page.evaluate(() => (globalThis as unknown as ProbeGlobal).__lt?.idleSince() ?? { now: performance.now(), lastEnd: 0 });
}

export function bench(page: Page, iterations: number): Promise<number> {
  return page.evaluate((n) => {
    const lt = (globalThis as unknown as ProbeGlobal).__lt;
    if (!lt) throw new Error('probe not installed in this page');
    return lt.bench(n);
  }, iterations);
}

export function elements(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lt = (globalThis as unknown as ProbeGlobal).__lt;
    if (!lt) throw new Error('probe not installed in this page');
    return lt.elements();
  });
}

export interface LongTaskSummary {
  count: number;
  /** Sum of the long tasks' durations (ms). */
  total: number;
  max: number;
  /** Total blocking time: sum of (duration − 50 ms). */
  blocking: number;
}

export function summarizeLongTasks(tasks: readonly LongTask[]): LongTaskSummary {
  let total = 0;
  let max = 0;
  let blocking = 0;
  for (const [, duration] of tasks) {
    total += duration;
    max = Math.max(max, duration);
    blocking += Math.max(0, duration - 50);
  }
  return { count: tasks.length, total: Math.round(total), max: Math.round(max), blocking: Math.round(blocking) };
}
