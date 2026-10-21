/**
 * Mounts a long list step by step instead of in one commit: the QR print
 * sheet of 2000 persons (every card computes its QR code) blocked phones in
 * one 0.74-s task (docs/LOADTEST-FINDINGS.md F4).
 *
 * After each commit the next step follows in a task of its own, as a
 * transition: React renders it in slices (user input goes first) and the
 * browser can paint and react between the steps. The steps double – `first`,
 * `first`, 2 × `first`, … – up to `maxStep`: every commit also lays out all
 * items rendered so far, so fewer, larger steps finish sooner, while
 * `maxStep` bounds the layout work of one step. `finish()` renders the rest
 * synchronously – for printing, which must never show a partial list.
 */
import { startTransition, useCallback, useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export interface ProgressiveCount {
  /** Items to render now (≤ total). */
  count: number;
  /** All items are rendered. */
  complete: boolean;
  /** Renders all remaining items synchronously (e.g. in a `beforeprint` handler). */
  finish: () => void;
}

/** The count after `count`: doubled, at least `first`, at most `maxStep` more. */
export function nextProgressiveCount(count: number, first: number, maxStep: number): number {
  return count + Math.min(maxStep, Math.max(first, count));
}

/** Counts up to `total` (see above); starts over when `resetKey` changes. */
export function useProgressiveCount(total: number, first: number, maxStep = first, resetKey = ''): ProgressiveCount {
  const [state, setState] = useState({ key: resetKey, count: first });
  const count = Math.min(total, state.key === resetKey ? state.count : first);
  const complete = count >= total;

  useEffect(() => {
    if (complete) return;
    const timer = window.setTimeout(() => {
      startTransition(() => {
        setState((current) => ({
          key: resetKey,
          count: nextProgressiveCount(current.key === resetKey ? current.count : first, first, maxStep),
        }));
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [complete, count, first, maxStep, resetKey]);

  const finish = useCallback(() => {
    flushSync(() => setState({ key: resetKey, count: Number.POSITIVE_INFINITY }));
  }, [resetKey]);

  return { count, complete, finish };
}
