// @ts-check
/// <reference lib="dom" />
/**
 * In-page instrumentation of the browser checks (src/ui/). Installed with
 * BrowserContext.addInitScript() into every document of a measured context, so
 * it runs before the app's own scripts. It runs in Chromium as a classic
 * script (no imports, no exports – only the IIFE below); it is type-checked
 * against probe.ts with `// @ts-check` + JSDoc (the tsconfig includes this one
 * JS file; the DOM lib reference above).
 *
 * Why in-page timing: Playwright's waits poll from Node with growing
 * intervals, which would add up to hundreds of milliseconds of jitter to a
 * 300 ms measurement. Here every time is taken in the page itself with
 * performance.now():
 *
 *   input      the user's input event (event.timeStamp = when the browser
 *              received the tap or key press, so a busy main thread counts)
 *   satisfied  the first animation frame in which the DOM shows the expected
 *              state; checked after DOM mutations (MutationObserver → one
 *              requestAnimationFrame), never by fixed sleeps. Conditions with
 *              `visible` (elements that fade in: toasts, the picker dialog)
 *              also need an effective opacity ≥ 0.5 – while one of them is
 *              pending it is checked in every frame, since a CSS animation
 *              changes no DOM.
 *   painted    the first task after that frame's rendering step (a
 *              'user-blocking' scheduler task posted from the frame
 *              callback) – i.e. the updated content has been laid out and
 *              painted
 *
 * A watch also reports conditions that were already true when it was armed
 * ("stale"): a measurement must never be satisfied by old content.
 *
 * Collected all the time (bounded buffers): long tasks, Event Timing entries
 * ≥ 16 ms, input events with their next paint, and URL.createObjectURL() calls
 * (= the app produced a download).
 */
(() => {
  /** @type {Window & { __lt?: import('./probe.ts').ProbeApi; __ltSink?: number }} */
  const win = window;
  if (win.__lt) return;

  const MAX_BUFFER = 2000;
  /**
   * @template T
   * @param {T[]} list
   * @param {T} item
   */
  const push = (list, item) => {
    list.push(item);
    if (list.length > MAX_BUFFER) list.splice(0, list.length - MAX_BUFFER);
  };

  const state = {
    /** @type {import('./probe.ts').LongTask[]} */
    longTasks: [],
    /** @type {import('./probe.ts').EventEntry[]} */
    events: [],
    /** @type {import('./probe.ts').ProbeInput[]} */
    inputs: [],
    /** @type {number[]} times of URL.createObjectURL() calls */
    blobs: [],
    /** @type {Map<string, import('./probe.ts').ProbeWatch>} */
    watches: new Map(),
    /** @type {Map<string, import('./probe.ts').WatchResult>} */
    results: new Map(),
    /** @type {Map<string, Array<(result: import('./probe.ts').WatchResult) => void>>} */
    waiters: new Map(),
    nextId: 1,
  };

  // ------------------------------------------------------------------ observers

  /**
   * @param {string} type
   * @param {PerformanceObserverInit & { durationThreshold?: number }} options Event Timing's threshold is not in the DOM lib yet
   * @param {(entry: PerformanceEntry) => void} onEntry
   */
  const observe = (type, options, onEntry) => {
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) onEntry(entry);
      }).observe({ type, buffered: true, ...options });
    } catch {
      // entry type not supported by this browser – the buffer stays empty
    }
  };
  observe('longtask', {}, (e) => push(state.longTasks, [e.startTime, e.duration]));
  observe('event', { durationThreshold: 16 }, (entry) => {
    const e = /** @type {PerformanceEventTiming} */ (entry);
    push(state.events, [e.name, e.startTime, e.processingStart, e.processingEnd, e.duration, e.interactionId ?? 0]);
  });

  /** @type {{ postTask?: (task: () => void, options: { priority: string }) => Promise<void> } | undefined} */
  const scheduler = /** @type {{ scheduler?: { postTask?: (task: () => void, options: { priority: string }) => Promise<void> } }} */ (
    /** @type {unknown} */ (win)
  ).scheduler;

  /**
   * Runs `fn` as the first task after the current frame's rendering step.
   * @param {(time: number) => void} fn
   */
  const afterFrame = (fn) => {
    const task = () => fn(performance.now());
    if (scheduler && typeof scheduler.postTask === 'function') {
      scheduler.postTask(task, { priority: 'user-blocking' }).catch(() => undefined);
    } else {
      win.setTimeout(task, 0);
    }
  };
  /**
   * Calls `fn(time)` after the next frame has been rendered.
   * @param {(time: number) => void} fn
   */
  const nextPaint = (fn) => win.requestAnimationFrame(() => afterFrame(fn));

  const INPUT_TYPES = ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'beforeinput', 'input', 'change', 'click'];
  for (const type of INPUT_TYPES) {
    win.addEventListener(
      type,
      (event) => {
        /** @type {import('./probe.ts').ProbeInput} */
        const record = { type, ts: event.timeStamp, at: performance.now(), trusted: event.isTrusted, paint: null };
        push(state.inputs, record);
        nextPaint((time) => {
          record.paint = time;
          if (state.watches.size > 0) scheduleTick();
        });
      },
      { capture: true, passive: true },
    );
  }

  try {
    const original = URL.createObjectURL;
    URL.createObjectURL = function createObjectURL(object) {
      push(state.blobs, performance.now());
      return original.call(URL, object);
    };
  } catch {
    // not patchable – the { blob } condition then never becomes true
  }

  // ------------------------------------------------------------------ conditions

  /** @param {string | null | undefined} text */
  const norm = (text) =>
    String(text ?? '')
      .replace(/[  ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /**
   * Visibly painted: rendered with a size, not hidden by CSS and an effective
   * opacity (own × ancestors', incl. running CSS animations) of at least 0.5.
   * @param {Element} el
   */
  const isVisible = (el) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    let opacity = 1;
    for (let node = /** @type {Element | null} */ (el); node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity);
    }
    return opacity >= 0.5;
  };

  /**
   * Declarative condition (JSON, built by src/ui/conditions.ts; types in probe.ts):
   *   { all: [...] } | { any: [...] } | { not: c }
   *   { path: '/x' }                       location.pathname
   *   { param: [name, value | null] }      URL search param (null = absent)
   *   { blob: true }                       URL.createObjectURL() called after the watch was armed
   *   { input: true }                      an input event arrived after arming and its next frame was painted
   *   { sel, ...checks }                   on document.querySelector(sel) unless noted:
   *     absent: true                       no match
   *     children: n                        childElementCount
   *     minChildren: n                     childElementCount ≥ n
   *     text: s / contains: s              normalized textContent equal / includes
   *     attr: [name, value]                attribute value
   *     count: n / min: n                  querySelectorAll(sel).length (only for small lists)
   *     anyContains: s                     some match's text includes s
   *     countContains: [s, n]              number of matches whose text includes s
   *     visible: true                      the element (anyContains: a matching one) is visibly painted
   * @param {import('./probe.ts').Cond} c
   * @param {import('./probe.ts').ProbeWatch} watch
   * @returns {boolean}
   */
  const check = (c, watch) => {
    if ('all' in c) return c.all.every((part) => check(part, watch));
    if ('any' in c) return c.any.some((part) => check(part, watch));
    if ('not' in c) return !check(c.not, watch);
    if ('path' in c) return location.pathname === c.path;
    if ('param' in c) return new URLSearchParams(location.search).get(c.param[0]) === c.param[1];
    if ('blob' in c) return state.blobs.some((time) => time >= watch.armAt);
    if ('input' in c) return state.inputs.some((input) => input.at >= watch.armAt && input.paint !== null);

    const listChecks =
      c.count !== undefined || c.min !== undefined || c.anyContains !== undefined || c.countContains !== undefined;
    const single =
      c.absent !== undefined ||
      c.children !== undefined ||
      c.minChildren !== undefined ||
      c.attr !== undefined ||
      c.text !== undefined ||
      c.contains !== undefined;
    if (listChecks) {
      const all = Array.from(document.querySelectorAll(c.sel));
      if (c.count !== undefined && all.length !== c.count) return false;
      if (c.min !== undefined && all.length < c.min) return false;
      const needle = c.anyContains;
      if (needle !== undefined && !all.some((el) => norm(el.textContent).includes(needle) && (!c.visible || isVisible(el)))) {
        return false;
      }
      if (c.countContains !== undefined) {
        const [text, expected] = c.countContains;
        if (all.filter((el) => norm(el.textContent).includes(text)).length !== expected) return false;
      }
      if (!single) {
        const first = all[0];
        return c.visible && needle === undefined ? first !== undefined && isVisible(first) : true;
      }
    }
    const el = document.querySelector(c.sel);
    if (c.absent) return el === null;
    if (!el) return false;
    if (c.children !== undefined && el.childElementCount !== c.children) return false;
    if (c.minChildren !== undefined && el.childElementCount < c.minChildren) return false;
    if (c.attr !== undefined && el.getAttribute(c.attr[0]) !== c.attr[1]) return false;
    if (c.text !== undefined && norm(el.textContent) !== c.text) return false;
    if (c.contains !== undefined && !norm(el.textContent).includes(c.contains)) return false;
    if (c.visible && c.anyContains === undefined && !isVisible(el)) return false;
    return true;
  };

  /**
   * @param {import('./probe.ts').Cond} cond
   * @param {import('./probe.ts').ProbeWatch} watch
   */
  const safeCheck = (cond, watch) => {
    try {
      return check(cond, watch);
    } catch (error) {
      watch.error = String(error instanceof Error ? error.message : error);
      return false;
    }
  };

  /**
   * Visibility conditions need a check in every frame (opacity animations change no DOM).
   * @param {import('./probe.ts').Cond} c
   * @returns {boolean}
   */
  const needsEveryFrame = (c) => {
    if ('all' in c) return c.all.some(needsEveryFrame);
    if ('any' in c) return c.any.some(needsEveryFrame);
    if ('not' in c) return needsEveryFrame(c.not);
    return 'sel' in c && c.visible === true;
  };

  /**
   * Attribute names a condition depends on (selectors and attr checks).
   * @param {import('./probe.ts').Cond} c
   * @param {Set<string>} into
   */
  const collectAttributes = (c, into) => {
    if ('all' in c) for (const part of c.all) collectAttributes(part, into);
    else if ('any' in c) for (const part of c.any) collectAttributes(part, into);
    else if ('not' in c) collectAttributes(c.not, into);
    else if ('sel' in c) {
      for (const match of c.sel.matchAll(/\[\s*([\w-]+)/g)) if (match[1]) into.add(match[1]);
      if (c.attr) into.add(c.attr[0]);
    }
  };

  // ------------------------------------------------------------------ watches

  let tickScheduled = false;
  /** @type {string | null} the attribute filter the observer runs with (null = not observing) */
  let observing = null;
  let fallbackTimer = 0;
  const mutations = new MutationObserver(() => scheduleTick());

  /**
   * Observes the DOM only while a watch is armed (no overhead otherwise), and
   * only the attributes the armed conditions depend on: big re-renders then
   * produce childList / text records, not one record per changed attribute.
   */
  const updateObserver = () => {
    if (state.watches.size === 0) {
      if (observing !== null) {
        observing = null;
        mutations.disconnect();
        win.clearInterval(fallbackTimer);
      }
      return;
    }
    /** @type {Set<string>} */
    const names = new Set();
    for (const watch of state.watches.values()) for (const name of watch.attributes) names.add(name);
    const key = [...names].sort().join(' ');
    if (observing === key) return;
    if (observing === null) {
      // non-DOM conditions (URL) and missed frames: a slow safety net
      fallbackTimer = win.setInterval(scheduleTick, 200);
    }
    observing = key;
    /** @type {MutationObserverInit} */
    const options = { subtree: true, childList: true, characterData: true };
    if (names.size > 0) options.attributeFilter = [...names];
    mutations.observe(document, options);
  };

  function scheduleTick() {
    if (tickScheduled || state.watches.size === 0) return;
    tickScheduled = true;
    win.requestAnimationFrame(tick);
  }

  function tick() {
    tickScheduled = false;
    const time = performance.now();
    let everyFrame = false;
    for (const watch of [...state.watches.values()]) {
      if (time > watch.deadline) {
        finish(watch, true);
        continue;
      }
      for (const [key, cond] of [...watch.pending]) {
        if (!safeCheck(cond, watch)) continue;
        watch.pending.delete(key);
        /** @type {import('./probe.ts').Mark} */
        const mark = { satisfiedAt: time, paintedAt: null, stale: false };
        watch.keys[key] = mark;
        afterFrame((painted) => {
          mark.paintedAt = painted;
          maybeFinish(watch);
        });
      }
      if (watch.everyFrame && [...watch.pending.values()].some(needsEveryFrame)) everyFrame = true;
    }
    if (everyFrame) scheduleTick();
  }

  /** @param {import('./probe.ts').ProbeWatch} watch */
  const maybeFinish = (watch) => {
    if (watch.pending.size > 0) return;
    if (Object.values(watch.keys).some((mark) => mark.paintedAt === null)) return;
    finish(watch, false);
  };

  /**
   * @param {import('./probe.ts').ProbeWatch} watch
   * @param {boolean} timedOut
   */
  function finish(watch, timedOut) {
    if (!state.watches.has(watch.id)) return;
    state.watches.delete(watch.id);
    win.clearTimeout(watch.timer);
    updateObserver();
    const doneAt = performance.now();
    const inputs = state.inputs.filter((input) => input.at >= watch.armAt && input.at <= doneAt);
    /** @type {import('./probe.ts').ProbeInput | null} */
    let first = null;
    for (const input of inputs) if (first === null || input.ts < first.ts) first = input;
    // the input events of one tap / key press arrive within a few ms; their last next paint
    const start = first;
    const burst = start ? inputs.filter((input) => input.trusted && input.at <= start.at + 200) : [];
    const paints = burst.map((input) => input.paint).filter((paint) => paint !== null);
    /** @type {import('./probe.ts').WatchResult} */
    const result = {
      id: watch.id,
      armAt: watch.armAt,
      doneAt,
      timedOut,
      error: watch.error,
      origin: performance.timeOrigin,
      input: start ? { type: start.type, ts: start.ts, trusted: start.trusted } : null,
      inputPaint: paints.length > 0 ? Math.max(...paints) : null,
      keys: Object.fromEntries(Object.keys(watch.conds).map((key) => [key, watch.keys[key] ?? null])),
      pending: [...watch.pending.keys()],
    };
    state.results.set(watch.id, result);
    const waiters = state.waiters.get(watch.id) ?? [];
    state.waiters.delete(watch.id);
    for (const resolve of waiters) resolve(result);
  }

  /**
   * @param {import('./probe.ts').Conds} conds
   * @param {number} timeoutMs
   * @param {string} [id]
   */
  const arm = (conds, timeoutMs, id) => {
    const watchId = id ?? `w${state.nextId++}`;
    state.results.delete(watchId);
    const armAt = performance.now();
    /** @type {Set<string>} */
    const attributes = new Set();
    for (const cond of Object.values(conds)) collectAttributes(cond, attributes);
    /** @type {import('./probe.ts').ProbeWatch} */
    const watch = {
      id: watchId,
      armAt,
      deadline: armAt + timeoutMs,
      conds,
      pending: new Map(),
      keys: {},
      error: null,
      timer: 0,
      everyFrame: Object.values(conds).some(needsEveryFrame),
      attributes: [...attributes],
    };
    for (const [key, cond] of Object.entries(conds)) {
      if (safeCheck(cond, watch)) watch.keys[key] = { satisfiedAt: armAt, paintedAt: armAt, stale: true };
      else watch.pending.set(key, cond);
    }
    state.watches.set(watchId, watch);
    watch.timer = win.setTimeout(() => finish(watch, true), timeoutMs + 50);
    updateObserver();
    if (watch.pending.size === 0) finish(watch, false);
    else scheduleTick();
    return watchId;
  };

  // ------------------------------------------------------------------ API

  /**
   * @template {unknown[]} E
   * @param {E[]} list
   * @param {number} from
   * @param {number} to
   * @param {(entry: E) => number} start
   * @param {(entry: E) => number} end
   */
  const between = (list, from, to, start, end) => list.filter((entry) => start(entry) < to && end(entry) > from);

  /** @type {import('./probe.ts').ProbeApi} */
  const api = {
    arm: (conds, timeoutMs) => arm(conds, timeoutMs),
    armLoad: (conds, timeoutMs) => arm(conds, timeoutMs, 'load'),
    result: (id) => {
      const done = state.results.get(id);
      if (done) return Promise.resolve(done);
      if (!state.watches.has(id)) return Promise.resolve(null);
      return new Promise((resolve) => {
        const list = state.waiters.get(id) ?? [];
        list.push(resolve);
        state.waiters.set(id, list);
      });
    },
    longTasksBetween: (from, to) =>
      between(
        state.longTasks,
        from,
        to,
        (e) => e[0],
        (e) => e[0] + e[1],
      ),
    eventsBetween: (from, to) =>
      between(
        state.events,
        from,
        to,
        (e) => e[1],
        (e) => e[1] + e[4],
      ),
    idleSince: () => ({
      now: performance.now(),
      lastEnd: state.longTasks.reduce((last, [start, duration]) => Math.max(last, start + duration), 0),
    }),
    bench: (iterations) => {
      const start = performance.now();
      let x = 0;
      for (let i = 0; i < iterations; i++) x = (x + Math.sqrt(i) * 1.000001) % 1e9;
      win.__ltSink = x;
      return performance.now() - start;
    },
    elements: () => document.getElementsByTagName('*').length,
  };
  win.__lt = api;
})();
