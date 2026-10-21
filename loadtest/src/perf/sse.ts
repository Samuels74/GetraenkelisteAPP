/**
 * A real PocketBase realtime client (Server-Sent Events) for Node, which has
 * no global EventSource: GET /api/realtime on a connection of its own, wait
 * for PB_CONNECT (its id is the clientId), then POST /api/realtime with the
 * subscriptions – what the SDK's RealtimeService does for the SPA.
 *
 * Real connections matter for the measurements: every open stream is a
 * long-lived request with its own server-side client state (≈ 0.07 MiB of
 * PocketBase memory each since static.pb.js serves the SPA through a route
 * of its own – before, a global JS middleware pinned one JS VM per stream,
 * ≈ 0.5 MiB), and every booking is broadcast to every subscriber (an access
 * check + a JSON encoding per client).
 *
 * Like the SDK, the client reconnects when the server ends the stream – after
 * 5 minutes without a message (idle timeout) or 30 minutes in total
 * (apis/realtime.go) – after 200 ms with a new clientId and submits the
 * subscriptions again; onConnect reports such reconnects so the SPA device
 * model can refetch everything as the app does.
 *
 * The frame parser handles PocketBase's format (`id:…\nevent:…\ndata:…\n\n`)
 * and tolerates CRLF line ends, comment lines and a space after the colon.
 */
import http from 'node:http';
import type { HttpClient } from './http.ts';
import { paths } from './requests.ts';

export interface SseOptions {
  /** Base URL of PocketBase. */
  url: string;
  /** Client for the subscription POST (carries the token; usually the device's client). */
  client: HttpClient;
  topics: string[];
  /** Called for every message except PB_CONNECT. `at` = performance.now() on arrival. */
  onMessage?: (event: string, data: string, at: number) => void;
  /** Called after each successful (re)subscription. */
  onConnect?: (info: { clientId: string; reconnect: boolean }) => void;
  /** Called when the server ended the stream. */
  onDisconnect?: () => void;
  /** Reconnect after the server ended the stream (default true, like the SDK). */
  reconnect?: boolean;
  /** Delay before reconnecting (SDK: 200 ms for the first attempt). */
  reconnectDelayMs?: number;
  /** Timeout for PB_CONNECT + subscription (default 15 s). */
  connectTimeoutMs?: number;
}

export interface SseStats {
  /** Successful subscriptions (first connect + reconnects). */
  connects: number;
  reconnects: number;
  /** Streams ended by the server (idle / max lifetime / shutdown). */
  serverCloses: number;
  /** Messages received (without PB_CONNECT). */
  messages: number;
  /** Bytes received on the stream. */
  bytes: number;
  /** Subscription POSTs that failed. */
  subscribeErrors: number;
}

export class SseClient {
  readonly stats: SseStats = { connects: 0, reconnects: 0, serverCloses: 0, messages: 0, bytes: 0, subscribeErrors: 0 };
  private readonly options: SseOptions;
  private request: http.ClientRequest | undefined;
  private closed = false;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(options: SseOptions) {
    this.options = options;
  }

  /** Opens the stream and subscribes; resolves once subscribed. */
  open(): Promise<void> {
    return this.connect(false);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Subscribed and the stream still open (pb.realtime.isConnected). */
  get isConnected(): boolean {
    return this.connected;
  }

  private connect(reconnect: boolean): Promise<void> {
    const { url, client, topics } = this.options;
    const target = new URL(paths.realtime(), url);
    return new Promise<void>((resolve, reject) => {
      let subscribed = false;
      let buffer = '';
      const timeout = setTimeout(() => {
        if (!subscribed) {
          req.destroy(new Error(`no PB_CONNECT/subscription within ${this.options.connectTimeoutMs ?? 15_000} ms`));
        }
      }, this.options.connectTimeoutMs ?? 15_000);
      const fail = (error: Error) => {
        clearTimeout(timeout);
        if (!subscribed) reject(error);
      };

      const subscribe = async (clientId: string) => {
        const result = await client.post(paths.realtime(), { clientId, subscriptions: topics });
        if (result.status !== 204) {
          this.stats.subscribeErrors++;
          req.destroy(new Error(`realtime subscription failed: ${result.error ?? `HTTP ${result.status}`}`));
          return;
        }
        subscribed = true;
        this.connected = !this.closed;
        clearTimeout(timeout);
        this.stats.connects++;
        if (reconnect) this.stats.reconnects++;
        this.options.onConnect?.({ clientId, reconnect });
        resolve();
      };

      const handleFrame = (frame: string, at: number) => {
        let event = 'message';
        let id = '';
        const data: string[] = [];
        for (const rawLine of frame.split('\n')) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line === '' || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
          else if (field === 'id') id = value;
        }
        if (event === 'PB_CONNECT') {
          void subscribe(id);
          return;
        }
        this.stats.messages++;
        this.options.onMessage?.(event, data.join('\n'), at);
      };

      const req = http.get(
        { host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80), path: target.pathname, agent: false },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            fail(new Error(`realtime connect failed: HTTP ${res.statusCode}`));
            return;
          }
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            const at = performance.now();
            this.stats.bytes += Buffer.byteLength(chunk);
            buffer += chunk;
            for (;;) {
              const lf = buffer.indexOf('\n\n');
              const crlf = buffer.indexOf('\r\n\r\n');
              const end = lf === -1 ? crlf : crlf === -1 ? lf : Math.min(lf, crlf);
              if (end === -1) break;
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + (end === crlf ? 4 : 2));
              handleFrame(frame, at);
            }
          });
          const onEnd = () => {
            if (!subscribed) fail(new Error('the realtime stream ended before the subscription'));
            this.ended(subscribed);
          };
          res.on('end', onEnd);
          res.on('error', onEnd);
        },
      );
      req.on('socket', (socket) => socket.setNoDelay(true));
      req.on('error', (error) => {
        fail(error);
        if (subscribed) this.ended(true);
      });
      this.request = req;
    });
  }

  /** The stream ended (server close, network error). */
  private ended(wasSubscribed: boolean): void {
    if (wasSubscribed) this.connected = false;
    if (this.closed || !wasSubscribed) return;
    this.stats.serverCloses++;
    this.options.onDisconnect?.();
    if (this.options.reconnect === false) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.closed) return;
      this.connect(true).catch(() => {
        // the SDK retries with growing delays; one more attempt after a second is enough here
        if (!this.closed) this.reconnectTimer = setTimeout(() => void this.connect(true).catch(() => undefined), 1000);
      });
    }, this.options.reconnectDelayMs ?? 200);
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    this.request?.destroy();
  }
}

/** The fields of a booking record the SPA's booking sync reads (undefined when missing or not a string). */
export interface EventRecord {
  id: string;
  person?: string;
  createdBy?: string;
  created?: string;
}

/**
 * Parses a record event's data: `{"action":"create","record":{…}}`; null
 * when the data is no record event at all.
 */
export function parseRecordEvent(data: string): { action: string; id: string; record: EventRecord } | null {
  try {
    const parsed = JSON.parse(data) as { action?: unknown; record?: Record<string, unknown> };
    const raw = parsed.record;
    if (typeof parsed.action !== 'string' || typeof raw?.id !== 'string') return null;
    const field = (name: string) => (typeof raw[name] === 'string' ? raw[name] : undefined);
    return {
      action: parsed.action,
      id: raw.id,
      record: { id: raw.id, person: field('person'), createdBy: field('createdBy'), created: field('created') },
    };
  } catch {
    return null;
  }
}
