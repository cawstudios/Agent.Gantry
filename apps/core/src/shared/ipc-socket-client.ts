import net from 'net';
import { randomUUID } from 'crypto';
import { IpcConnection } from './ipc-connection.js';
import type { IpcWireFrame, IpcWireChannel } from './ipc-wire.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IpcRequestError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'IpcRequestError';
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface IpcSocketClientReconnect {
  enabled: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
  /**
   * Pure-socket mode keeps in-flight request frames across a transient
   * connection drop and replays them after the next successful handshake with
   * the same frame id.
   */
  replayPending?: boolean;
}

export interface IpcSocketClientOptions {
  socketPath: string;
  /**
   * Returns a FRESHLY-signed hello payload each call (fresh nonce/expiry) —
   * re-invoked on every (re)connect.
   */
  buildHello: () => Record<string, unknown>;
  /**
   * ed25519 response verification. If provided, a resp whose signature fails
   * verification REJECTS the request (fail-closed). The payload passed is the
   * resp payload WITHOUT the `signature` field.
   */
  verifyResponse?: (
    payloadWithoutSignature: Record<string, unknown>,
    signature: string,
  ) => boolean;
  /**
   * Receives push frames (continuation/close/live_tool_rules) and any ctrl the
   * engine does not handle itself.
   */
  onPush?: (frame: IpcWireFrame) => void;
  /** Called after every successful hello/welcome, including reconnects. */
  onConnect?: () => void;
  /** Reconnect policy. Default { enabled: false }. */
  reconnect?: IpcSocketClientReconnect;
  /**
   * When true, `unref()` the underlying socket so the connection NEVER by itself
   * keeps the Node event loop alive. Use for a long-lived owner whose lifetime is
   * pinned by some OTHER handle (e.g. the gantry-MCP grandchild, held open by its
   * stdio transport): the socket is a dependent resource, not a reason to stay
   * alive, so the process can exit cleanly when that other handle closes even if
   * this client is never explicitly closed. Default false (socket keeps the loop
   * alive — correct for a client that is explicitly close()d, like the runner).
   */
  unref?: boolean;
  /** Connect/handshake timeout in ms. Default 5000. */
  connectTimeoutMs?: number;
  /** Frame body size cap forwarded to IpcConnection. */
  maxBytes?: number;
  /** Injectable for tests; default real net.connect. */
  connectFn?: (socketPath: string) => net.Socket;
  /** Injectable for reconnect-backoff jitter determinism in tests. */
  randomFn?: () => number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (payload: Record<string, unknown>) => void;
  reject: (err: IpcRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
  frame: IpcWireFrame;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_MS = 200;
const DEFAULT_RECONNECT_MAX_MS = 5000;

// ---------------------------------------------------------------------------
// IpcSocketClient
// ---------------------------------------------------------------------------

export class IpcSocketClient {
  private readonly socketPath: string;
  private readonly buildHello: () => Record<string, unknown>;
  private readonly verifyResponse?: (
    payloadWithoutSignature: Record<string, unknown>,
    signature: string,
  ) => boolean;
  private readonly onPush?: (frame: IpcWireFrame) => void;
  private readonly onConnect?: () => void;
  private readonly reconnectCfg: IpcSocketClientReconnect;
  private readonly unrefSocket: boolean;
  private readonly connectTimeoutMs: number;
  private readonly maxBytes: number | undefined;
  private readonly connectFn: (socketPath: string) => net.Socket;
  private readonly randomFn: () => number;

  private conn: IpcConnection | undefined;
  private _connected = false;
  private explicitlyClosed = false;

  private readonly pending = new Map<string, PendingRequest>();

  /** Resolver for the in-flight connect()/reconnect handshake, if any. */
  private connectResolve: (() => void) | undefined;
  private connectReject: ((err: Error) => void) | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: IpcSocketClientOptions) {
    this.socketPath = opts.socketPath;
    this.buildHello = opts.buildHello;
    this.verifyResponse = opts.verifyResponse;
    this.onPush = opts.onPush;
    this.onConnect = opts.onConnect;
    this.reconnectCfg = opts.reconnect ?? { enabled: false };
    this.unrefSocket = opts.unref ?? false;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes;
    this.connectFn = opts.connectFn ?? ((p) => net.connect(p));
    this.randomFn = opts.randomFn ?? Math.random;
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get connected(): boolean {
    return this._connected;
  }

  // -------------------------------------------------------------------------
  // connect
  // -------------------------------------------------------------------------

  connect(): Promise<void> {
    this.explicitlyClosed = false;
    return new Promise<void>((resolve, reject) => {
      this.openConnection(resolve, reject);
    });
  }

  /**
   * Open a fresh connection + send hello. `resolve`/`reject` settle the caller's
   * connect() promise (for the initial connect) or are no-ops on reconnect.
   */
  private openConnection(
    resolve: (() => void) | undefined,
    reject: ((err: Error) => void) | undefined,
  ): void {
    let socket: net.Socket;
    try {
      socket = this.connectFn(this.socketPath);
    } catch (err) {
      reject?.(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnectIfNeeded();
      return;
    }

    // A long-lived owner (e.g. the gantry-MCP grandchild) is kept alive by some
    // other handle; the socket must not by itself pin the event loop, or the
    // process can't exit cleanly when that handle closes. unref() makes it a
    // dependent resource. No-op for fakes without unref (tests).
    if (
      this.unrefSocket &&
      typeof (socket as { unref?: () => void }).unref === 'function'
    ) {
      (socket as { unref: () => void }).unref();
    }

    this.connectResolve = resolve;
    this.connectReject = reject;

    const conn = new IpcConnection({
      socket,
      maxBytes: this.maxBytes,
      onFrame: (frame) => this.handleFrame(frame),
      onClose: (reason) => this.handleClose(reason),
      onError: () => {
        /* surfaced via onClose('socket_error', ...) */
      },
    });
    this.conn = conn;

    // Arm the connect/handshake timeout. Cleared on welcome.
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      // Destroying triggers handleClose, which rejects the pending connect.
      conn.destroy('connect_timeout');
    }, this.connectTimeoutMs);
    if (
      typeof this.connectTimer === 'object' &&
      this.connectTimer !== null &&
      'unref' in this.connectTimer
    ) {
      (this.connectTimer as { unref(): void }).unref();
    }

    // Send a freshly-signed hello (fresh nonce/expiry every (re)connect).
    conn.send({
      v: 1,
      type: 'ctrl',
      channel: null,
      ctrl: 'hello',
      id: randomUUID(),
      payload: this.buildHello(),
    });
  }

  // -------------------------------------------------------------------------
  // request / send
  // -------------------------------------------------------------------------

  request(
    channel: IpcWireChannel,
    signedPayload: Record<string, unknown>,
    opts?: { id?: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (!this._connected || !this.conn) {
      return Promise.reject(
        new IpcRequestError('not connected', 'not_connected'),
      );
    }
    const id = opts?.id ?? randomUUID();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const frame: IpcWireFrame = {
      v: 1,
      type: 'req',
      channel,
      id,
      payload: signedPayload,
    };

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcRequestError('request timed out', 'timeout'));
      }, timeoutMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as { unref(): void }).unref();
      }
      this.pending.set(id, { resolve, reject, timer, frame });

      this.conn!.send(frame);
    });
  }

  send(channel: IpcWireChannel, signedPayload: Record<string, unknown>): void {
    if (!this._connected || !this.conn) return;
    this.conn.send({
      v: 1,
      type: 'req',
      channel,
      id: randomUUID(),
      payload: signedPayload,
    });
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.rejectAllPending('client_close');
    const conn = this.conn;
    this.conn = undefined;
    this._connected = false;
    conn?.destroy('client_close');
  }

  // -------------------------------------------------------------------------
  // Frame handling
  // -------------------------------------------------------------------------

  private handleFrame(frame: IpcWireFrame): void {
    // Handshake completion.
    if (frame.type === 'ctrl' && frame.ctrl === 'welcome') {
      this.onWelcome();
      return;
    }

    if (frame.type === 'resp') {
      this.handleResp(frame);
      return;
    }

    // busy ctrl that targets a pending request id rejects that request.
    if (frame.type === 'ctrl' && frame.ctrl === 'busy') {
      const entry = this.pending.get(frame.id);
      if (entry) {
        this.pending.delete(frame.id);
        clearTimeout(entry.timer);
        entry.reject(new IpcRequestError('server busy', 'busy'));
        return;
      }
      // No matching pending → fall through to onPush as an unhandled ctrl.
    }

    // push frames, or any other unhandled ctrl → consumer.
    this.onPush?.(frame);
  }

  private onWelcome(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this._connected = true;
    this.reconnectAttempts = 0;
    this.conn?.startHeartbeat();
    const resolve = this.connectResolve;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    resolve?.();
    this.onConnect?.();
    this.replayPendingFrames();
  }

  private replayPendingFrames(): void {
    if (!this.reconnectCfg.replayPending || !this.conn || !this._connected) {
      return;
    }
    for (const entry of this.pending.values()) {
      this.conn.send(entry.frame);
    }
  }

  private handleResp(frame: IpcWireFrame): void {
    const entry = this.pending.get(frame.id);
    if (!entry) return; // late/orphan resp — ignore.

    const payload = frame.payload as Record<string, unknown>;

    // Fail-closed signature check. A signed handler response is the ONLY
    // trusted application shape: when verifyResponse is configured, every
    // application resp, success OR failure, MUST carry a verifiable signature.
    // A missing/non-string signature is itself a verification failure, exactly
    // mirroring the fs path.
    //
    // Core-generated transport rejects are the only unsigned exception. They
    // are emitted by the socket server before application handlers run and are
    // explicitly marked so an unsigned application-level ok:false cannot
    // masquerade as transport failure.
    const isTransportReject =
      payload.ok === false && payload.transport === true;
    if (this.verifyResponse && !isTransportReject) {
      if (typeof payload.signature !== 'string') {
        this.settleReject(
          frame.id,
          new IpcRequestError('missing response signature', 'bad_signature'),
        );
        return;
      }
      const { signature, ...withoutSig } = payload as {
        signature?: string;
      } & Record<string, unknown>;
      const ok = this.verifyResponse(withoutSig, String(signature));
      if (!ok) {
        this.settleReject(
          frame.id,
          new IpcRequestError('bad response signature', 'bad_signature'),
        );
        return;
      }
    }

    if (payload.ok === false) {
      const code = String(payload.code ?? 'error');
      const message = String(payload.error ?? payload.code ?? 'request failed');
      this.settleReject(frame.id, new IpcRequestError(message, code));
      return;
    }

    // Success.
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    entry.resolve(payload);
  }

  private settleReject(id: string, err: IpcRequestError): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  // -------------------------------------------------------------------------
  // Close + reconnect
  // -------------------------------------------------------------------------

  private handleClose(reason: string): void {
    this._connected = false;
    this.conn = undefined;

    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }

    // Reject a pending connect()/handshake (closed before welcome).
    const connectReject = this.connectReject;
    this.connectResolve = undefined;
    this.connectReject = undefined;
    if (connectReject) {
      connectReject(
        new IpcRequestError(`connection lost: ${reason}`, 'connection_lost'),
      );
    }

    const keepPendingForReplay =
      this.reconnectCfg.enabled &&
      this.reconnectCfg.replayPending === true &&
      !this.explicitlyClosed;
    const reconnectScheduled = this.scheduleReconnectIfNeeded();
    if (keepPendingForReplay && reconnectScheduled) {
      return;
    }

    this.rejectAllPending(reason);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(
        new IpcRequestError(`connection lost: ${reason}`, 'connection_lost'),
      );
    }
  }

  private scheduleReconnectIfNeeded(): boolean {
    if (!this.reconnectCfg.enabled || this.explicitlyClosed) return false;
    const maxAttempts = this.reconnectCfg.maxAttempts ?? Infinity;
    if (this.reconnectAttempts >= maxAttempts) return false;

    const base = this.reconnectCfg.baseDelayMs ?? DEFAULT_RECONNECT_BASE_MS;
    const max = this.reconnectCfg.maxDelayMs ?? DEFAULT_RECONNECT_MAX_MS;
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts += 1;

    // Exponential backoff with full jitter, capped at max.
    const expo = Math.min(max, base * Math.pow(2, attempt));
    const delay = Math.floor(this.randomFn() * expo);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.explicitlyClosed) return;
      // Reconnect handshake settles internally; no caller promise to resolve.
      this.openConnection(undefined, undefined);
    }, delay);
    if (
      typeof this.reconnectTimer === 'object' &&
      this.reconnectTimer !== null &&
      'unref' in this.reconnectTimer
    ) {
      (this.reconnectTimer as { unref(): void }).unref();
    }
    return true;
  }
}
