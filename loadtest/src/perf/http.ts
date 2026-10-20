/**
 * The HTTP client of the performance checks: node:http with one keep-alive
 * agent per virtual device (a browser keeps its own connections, at most 6
 * per host – the realtime stream uses a connection of its own, see sse.ts).
 *
 * Why not fetch() or the PocketBase SDK: at a few thousand requests per
 * second the client's own CPU becomes the bottleneck (1B measured a single
 * fetch()-based Node process at ≈ 85 % of a core around 1,500 rps), and the
 * load generator must not limit what it measures. Bodies are drained and
 * only counted unless the caller needs them (`collect`), nothing is parsed
 * that is not needed.
 *
 * Never throws for HTTP or network errors: every outcome becomes an
 * HttpResult (status 0 = no response: refused, reset, timeout, aborted), so
 * the scenarios count errors instead of crashing on them.
 */
import http from 'node:http';

export interface HttpResult {
  /** HTTP status; 0 = no response (network error, timeout, abort). */
  status: number;
  /** Response body size in bytes as transferred (PocketBase does not compress API responses). */
  bytes: number;
  /** Request start → last body byte, in ms. */
  ms: number;
  /** Request start → response headers, in ms. */
  ttfbMs: number;
  /** performance.now() when the request started (thread-local clock). */
  startedAt: number;
  /** The body: with `collect`, and always for error statuses (≤ 4 KiB, for the error message). */
  body?: Buffer;
  /** One-line error description for status 0 and error statuses. */
  error?: string;
}

export interface RequestOptions {
  /** JSON request body. */
  body?: unknown;
  /** Keep the response body (e.g. to read a created record id). */
  collect?: boolean;
  /** Give up after this many ms (default 60 s) – the result then has status 0. */
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

const ERROR_BODY_LIMIT = 4096;

/** PocketBase's error message of an error response, e.g. "HTTP 400: Failed to create record." */
function describeHttpError(status: number, body: Buffer | undefined): string {
  let message = '';
  if (body && body.length > 0) {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown };
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      message = body.toString('utf8', 0, Math.min(body.length, 200)).replace(/\s+/g, ' ').trim();
    }
  }
  return `HTTP ${status}${message ? `: ${message}` : ''}`;
}

export class HttpClient {
  readonly baseUrl: string;
  /** Sent as `Authorization` (the SDK sends the bare token, no "Bearer"). */
  token: string | undefined;
  private readonly host: string;
  private readonly port: number;
  private readonly agent: http.Agent;
  private closed = false;

  constructor(baseUrl: string, options: { token?: string; maxSockets?: number } = {}) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:') throw new Error(`only http:// URLs are supported (got ${baseUrl})`);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.host = url.hostname.replace(/^\[|\]$/g, '');
    this.port = Number(url.port || 80);
    this.token = options.token;
    this.agent = new http.Agent({ keepAlive: true, maxSockets: options.maxSockets ?? 6 });
  }

  request(method: string, path: string, options: RequestOptions = {}): Promise<HttpResult> {
    const startedAt = performance.now();
    // a closed client sends nothing (a forgotten loop must not keep loading the server)
    if (this.closed) return Promise.resolve({ status: 0, bytes: 0, ms: 0, ttfbMs: 0, startedAt, error: 'client closed' });
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string | number> = { ...options.headers };
    if (this.token) headers.Authorization = this.token;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }

    return new Promise<HttpResult>((resolve) => {
      let settled = false;
      let ttfbMs = 0;
      let bytes = 0;
      let status = 0;
      const chunks: Buffer[] = [];
      let kept = 0;
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        const ms = performance.now() - startedAt;
        let body: Buffer | undefined;
        if (chunks.length > 0) body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
        const failed = error !== undefined || status === 0 || status >= 400;
        resolve({
          status: error !== undefined ? 0 : status,
          bytes,
          ms,
          ttfbMs,
          startedAt,
          body,
          error: failed ? (error ?? describeHttpError(status, body)) : undefined,
        });
      };

      const req = http.request(
        { host: this.host, port: this.port, method, path, headers, agent: this.agent, signal: options.signal },
        (res) => {
          ttfbMs = performance.now() - startedAt;
          status = res.statusCode ?? 0;
          const keep = options.collect || status >= 400;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (keep && (options.collect || kept < ERROR_BODY_LIMIT)) {
              chunks.push(chunk);
              kept += chunk.length;
            }
          });
          res.on('end', () => finish());
          res.on('error', (error) => finish(error.message));
          res.on('aborted', () => finish('response aborted'));
        },
      );
      req.on('socket', (socket) => socket.setNoDelay(true));
      req.setTimeout(options.timeoutMs ?? 60_000, () => req.destroy(new Error(`timeout after ${options.timeoutMs ?? 60_000} ms`)));
      req.on('error', (error) => finish(error.name === 'AbortError' ? 'aborted' : error.message));
      req.end(payload);
    });
  }

  get(path: string, options?: RequestOptions): Promise<HttpResult> {
    return this.request('GET', path, options);
  }

  post(path: string, body: unknown, options: RequestOptions = {}): Promise<HttpResult> {
    return this.request('POST', path, { ...options, body });
  }

  delete(path: string, options?: RequestOptions): Promise<HttpResult> {
    return this.request('DELETE', path, options);
  }

  /** Closes the kept-alive connections; later requests fail at once with "client closed". */
  close(): void {
    this.closed = true;
    this.agent.destroy();
  }
}

/** The collected body as JSON (throws with the status if the request failed). */
export function parseJson<T>(result: HttpResult): T {
  if (result.status < 200 || result.status >= 300 || !result.body) {
    throw new Error(result.error ?? `unexpected response (HTTP ${result.status}, no body)`);
  }
  return JSON.parse(result.body.toString('utf8')) as T;
}
