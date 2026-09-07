/**
 * The socket to a game server.
 *
 * This knows about connecting, joining, keeping a round-trip estimate and
 * coming back after a drop. It knows nothing about the simulation: messages
 * are handed to whoever is listening, and the session decides what they mean.
 *
 * Reconnection re-sends the join with the token from the first welcome, so a
 * brief drop lands the player back in the same seat.
 */
import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
  type StampedCommand,
} from '@boxhead/shared';

export type NetState = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'closed';

export interface JoinRequest {
  name: string;
  character: string;
  room?: string;
}

export interface NetClientEvents {
  onMessage: (message: ServerMessage) => void;
  onStateChange: (state: NetState, detail: string) => void;
}

const PING_MS = 1000;
const RETRY_MS = [1000, 2000, 4000, 8000, 8000];
const TOKEN_KEY = 'boxhead.seat';

/**
 * The seat token identifies a player to the server: it comes back in the
 * welcome and is presented again on the next join. It is kept per server in
 * localStorage, so closing the tab and opening a new one still lands in the
 * same seat while the server is holding it. The server only lets a token
 * reclaim a seat whose socket is gone, so a second tab opened alongside a
 * live one gets a fresh seat rather than stealing this one.
 */
function readToken(url: string): string | null {
  try {
    const raw = localStorage.getItem(`${TOKEN_KEY}:${url}`);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { token: string; at: number };
    if (Date.now() - saved.at > 10 * 60_000) return null;
    return saved.token;
  } catch {
    return null;
  }
}

function writeToken(url: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(`${TOKEN_KEY}:${url}`, JSON.stringify({ token, at: Date.now() }));
    else localStorage.removeItem(`${TOKEN_KEY}:${url}`);
  } catch {
    // Storage is a convenience; a blocked store just means no seat reclaim.
  }
}

export class NetClient {
  state: NetState = 'idle';
  /** Smoothed round trip, in milliseconds. */
  rttMs = 0;
  /** Server tick as of the last pong or snapshot. */
  serverTick = 0;
  private socket: WebSocket | null = null;
  private url = '';
  private join: JoinRequest | null = null;
  private token: string | null = null;
  private pingTimer = 0;
  private retryTimer = 0;
  private retries = 0;
  private closedByUser = false;

  constructor(
    private readonly events: NetClientEvents,
    private readonly makeSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  connect(url: string, join: JoinRequest): void {
    this.close();
    this.closedByUser = false;
    this.url = url;
    this.join = join;
    // A reload within the seat's grace period lands back in the same seat.
    this.token = readToken(url);
    this.retries = 0;
    this.open();
  }

  /** Hang up for good; no reconnect. */
  close(): void {
    // Closing an already closed client must be a no-op, not a second
    // 'closed' event: listeners that close in response would loop.
    const wasLive = this.state !== 'idle' && this.state !== 'closed';
    this.closedByUser = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(encode({ type: 'leave' }));
      socket.close();
    }
    if (wasLive) this.setState('closed', 'left');
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(encode(message));
  }

  sendInput(commands: StampedCommand[]): boolean {
    if (this.state !== 'joined' || commands.length === 0) return false;
    this.send({ type: 'input', commands });
    return true;
  }

  private setState(state: NetState, detail: string): void {
    this.state = state;
    this.events.onStateChange(state, detail);
  }

  private open(): void {
    let socket: WebSocket;
    try {
      socket = this.makeSocket(this.url);
    } catch (error) {
      this.setState('closed', error instanceof Error ? error.message : 'bad address');
      return;
    }
    this.socket = socket;
    this.setState(this.retries > 0 ? 'reconnecting' : 'connecting', this.url);

    socket.onopen = () => {
      if (!this.join) return;
      const message: ClientMessage = {
        type: 'join',
        protocol: PROTOCOL_VERSION,
        name: this.join.name,
        character: this.join.character,
        ...(this.join.room ? { room: this.join.room } : {}),
        ...(this.token ? { token: this.token } : {}),
      };
      socket.send(encode(message));
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      const message = decodeServerMessage(String(event.data));
      if (!message) return;
      this.receive(message);
    };
    socket.onclose = () => this.dropped('connection closed');
    socket.onerror = () => this.dropped('connection failed');
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
        this.token = message.token;
        writeToken(this.url, message.token);
        this.retries = 0;
        this.serverTick = message.tick;
        this.setState('joined', message.room);
        this.startPinging();
        break;
      case 'reject':
        // The server said no; retrying would only get the same answer, and a
        // stale token may be why.
        writeToken(this.url, null);
        this.closedByUser = true;
        this.setState('closed', message.reason);
        this.socket?.close();
        this.socket = null;
        break;
      case 'pong': {
        const sample = performance.now() - message.sent;
        this.rttMs = this.rttMs === 0 ? sample : this.rttMs * 0.8 + sample * 0.2;
        this.serverTick = Math.max(this.serverTick, message.tick);
        break;
      }
      case 'start':
        // A new match counts from zero again.
        this.serverTick = message.tick;
        break;
      case 'snapshot':
        this.serverTick = Math.max(this.serverTick, message.tick);
        break;
      default:
        break;
    }
    this.events.onMessage(message);
  }

  private startPinging(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping', sent: performance.now() });
    }, PING_MS);
  }

  private dropped(reason: string): void {
    if (!this.socket) return;
    this.socket = null;
    window.clearInterval(this.pingTimer);
    if (this.closedByUser) return;
    // A seat is held for a while after a drop, so keep trying for about that long.
    const wait = RETRY_MS[this.retries];
    if (wait === undefined) {
      this.setState('closed', reason);
      return;
    }
    this.retries += 1;
    this.setState('reconnecting', `${reason}; retrying in ${wait / 1000}s`);
    this.retryTimer = window.setTimeout(() => this.open(), wait);
  }
}
