import { type AddressInfo, createServer, type Socket } from 'node:net';
import { setTimeout as sleepReal } from 'node:timers/promises';
import { type WebSocket, WebSocketServer } from 'ws';

// A local WebSocket server for the realtime tests. It is the `ws` package, which is a
// devDependency only: it never reaches `src` or the published bundle. The server listens on
// 127.0.0.1 on a free port (port 0), so no test touches an external network.
//
// It mirrors the parts of the orderbook gateway the SDK depends on:
// - a text "PING" is answered with a text "PONG"; turn that off with `pong = false`;
// - `closeWith(1008, 'max_ws_connections_exceeded')` is how the gateway refuses a connection
//   over the per-user cap;
// - `drop()` ends the TCP connection with no close frame, so the client sees code 1006.
//
// The tests use `accept()` to take the connections in the order they arrive, then drive each one
// (`send`, `drop`, `closeWith`) and read what the client sent (`received`).

/** What the server saw when a connection closed. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/** One accepted connection, as the server sees it. */
export interface ServerConnection {
  /** The underlying `ws` socket, for anything the helpers below do not cover. */
  readonly socket: WebSocket;
  /** The path (and query) of the upgrade request, such as `/ws/market`. */
  readonly path: string;
  /** Every text frame the client has sent on this connection, in order. */
  readonly received: string[];
  /** Resolves when the connection has closed. */
  readonly closed: Promise<CloseInfo>;
  /** Sends a text frame to the client. */
  send(text: string): void;
  /** Sends a binary frame to the client. */
  sendBinary(bytes: Uint8Array): void;
  /** Closes with a close frame, as the gateway does for 1008. */
  closeWith(code: number, reason?: string): void;
  /** Ends the TCP connection at once, with no close frame. The client sees code 1006. */
  drop(): void;
  /**
   * Stops reading from the client for good: nothing it sends is processed from now on, so no
   * PONG and no close-frame reply ever comes. The TCP connection stays up. It is a peer that
   * has hung (or vanished without a FIN) as the client sees it. Uses `ws`'s internal socket.
   */
  stopReading(): void;
}

export interface WsTestServer {
  /** `ws://127.0.0.1:<port>` */
  readonly url: string;
  /** Every connection accepted so far, in arrival order. */
  readonly connections: readonly ServerConnection[];
  /** Answer a text "PING" with a text "PONG". On by default; assignable at any time. */
  pong: boolean;
  /** Send every other text frame straight back. Off by default; assignable at any time. */
  echo: boolean;
  /**
   * Answers each text frame other than "PING" with what it returns, when that is a string
   * (`echo` then does not apply to the frame). Off by default; assignable at any time.
   */
  reply: ((text: string) => string | undefined) | undefined;
  /**
   * Resolves with the next connection nobody has taken yet: connections are handed out one by
   * one in arrival order, whether they arrived before or after this call.
   */
  accept(): Promise<ServerConnection>;
  /** Drops every connection and stops listening. */
  close(): Promise<void>;
}

export interface WsTestServerOptions {
  echo?: boolean;
  pong?: boolean;
  reply?: (text: string) => string | undefined;
  /**
   * Runs for every new connection, before `accept()` can hand it out. For example, to refuse
   * every connection with 1008: `onConnection: (c) => c.closeWith(1008, '...')`.
   */
  onConnection?: (connection: ServerConnection) => void;
}

export async function startWsServer(
  options: WsTestServerOptions = {},
): Promise<WsTestServer> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  const { port } = wss.address() as AddressInfo;

  const connections: ServerConnection[] = [];
  const waiters: Array<(connection: ServerConnection) => void> = [];
  let handedOut = 0;

  const server: WsTestServer = {
    url: `ws://127.0.0.1:${port}`,
    connections,
    pong: options.pong ?? true,
    echo: options.echo ?? false,
    reply: options.reply,
    accept() {
      const ready = connections[handedOut];
      if (ready !== undefined) {
        handedOut += 1;
        return Promise.resolve(ready);
      }
      return new Promise<ServerConnection>((resolve) => waiters.push(resolve));
    },
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  wss.on('connection', (socket, request) => {
    // A client that vanishes mid-write must not turn into an unhandled 'error' event.
    socket.on('error', () => {});
    const received: string[] = [];
    const closed = new Promise<CloseInfo>((resolve) => {
      socket.once('close', (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    const connection: ServerConnection = {
      socket,
      path: request.url ?? '',
      received,
      closed,
      send: (text) => socket.send(text),
      sendBinary: (bytes) => socket.send(bytes, { binary: true }),
      closeWith: (code, reason) => socket.close(code, reason),
      drop: () => socket.terminate(),
      stopReading: () =>
        (socket as unknown as { _socket: Socket })._socket.pause(),
    };
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        return;
      }
      const text = data.toString();
      received.push(text);
      if (text === 'PING') {
        if (server.pong) {
          socket.send('PONG');
        }
      } else {
        const answer = server.reply?.(text);
        if (answer !== undefined) {
          socket.send(answer);
        } else if (server.echo) {
          socket.send(text);
        }
      }
    });
    connections.push(connection);
    options.onConnection?.(connection);
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      handedOut += 1;
      waiter(connection);
    }
  });

  return server;
}

/**
 * Polls `condition` every 5 ms until it is true; throws if it is not true within `timeoutMs`.
 * It waits on Node's own timers, which vitest's fake timers do not touch, so it works whatever a
 * test has faked.
 */
export async function waitUntil(
  condition: () => boolean,
  label = 'condition',
  timeoutMs = 3_000,
): Promise<void> {
  // Counting polls rather than reading the clock keeps this independent of a faked `Date`.
  for (let polls = 0; !condition(); polls += 1) {
    if (polls * 5 > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
    }
    await sleepReal(5);
  }
}

/**
 * Lets real I/O settle for `ms`, so a test can check that something did NOT happen. A pass is
 * weak evidence by nature (something slower than `ms` is missed), but it can never fail by chance.
 */
export function settle(ms = 30): Promise<void> {
  return sleepReal(ms);
}

/** A raw TCP listener that accepts connections and then says nothing, ever. */
export interface SilentTcpServer {
  /** `ws://127.0.0.1:<port>`: a WebSocket client connects, sends its upgrade request, and waits. */
  readonly url: string;
  /** How many TCP connections have been accepted. */
  readonly accepted: () => number;
  /** How many of them have since been closed by the client (the server saw the end). */
  readonly closed: () => number;
  close(): Promise<void>;
}

/**
 * A server whose TCP handshake succeeds but which never answers the WebSocket upgrade: the
 * connect attempt of a client hangs until it gives up. It is what a black-holed or overloaded
 * gateway looks like from the client.
 */
export async function startSilentTcpServer(): Promise<SilentTcpServer> {
  const sockets: Socket[] = [];
  let closed = 0;
  const tcp = createServer((socket) => {
    socket.on('error', () => {});
    socket.on('close', () => {
      closed += 1;
    });
    // Read and discard the client's upgrade request. Without this the socket never reads, so
    // it would never notice the client closing: the server must be silent, not deaf.
    socket.resume();
    sockets.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    tcp.once('listening', resolve);
    tcp.once('error', reject);
    tcp.listen(0, '127.0.0.1');
  });
  const { port } = tcp.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}`,
    accepted: () => sockets.length,
    closed: () => closed,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        tcp.close(() => resolve());
      }),
  };
}
