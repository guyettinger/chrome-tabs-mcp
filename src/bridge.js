import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

/**
 * Connects MCP server processes to the Chrome extension.
 *
 * The first process to bind the port becomes the hub: the extension connects to it, and so do
 * later processes (peers), whose requests the hub forwards. This lets several Claude Code
 * sessions share one extension. When the hub exits, a peer takes over the port and the
 * extension reconnects to it.
 */
export class Bridge extends EventEmitter {
  constructor({ host, port, token, log = () => {}, requestTimeoutMs = 30_000, extensionWaitMs = 10_000 }) {
    super();
    Object.assign(this, { host, port, token, log, requestTimeoutMs, extensionWaitMs });
    this.mode = null; // 'hub' | 'peer' | null
    this.wss = null;
    this.extension = null;
    this.hub = null;
    this.pending = new Map(); // id -> { resolve, reject, timer } | { peer }
    this.starting = null;
  }

  ensure() {
    if (this.mode) return Promise.resolve();
    this.starting ??= this.#start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start() {
    try {
      await this.#startHub();
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      await this.#startPeer();
    }
  }

  #startHub() {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 16 * 1024 * 1024 });
      wss.once('error', reject);
      wss.once('listening', () => {
        wss.off('error', reject);
        wss.on('error', (err) => this.log(`hub error: ${err.message}`));
        this.wss = wss;
        this.mode = 'hub';
        this.log(`hub listening on ${this.host}:${this.port}`);
        resolve();
      });
      wss.on('connection', (sock) => this.#onConnection(sock));
    });
  }

  #onConnection(sock) {
    const helloTimer = setTimeout(() => sock.close(4000, 'hello timeout'), 5_000);
    sock.once('message', (data) => {
      clearTimeout(helloTimer);
      const hello = parse(data);
      if (hello?.type !== 'hello' || hello.token !== this.token) {
        sock.close(4001, 'bad token');
        return;
      }
      if (hello.role === 'extension') this.#attachExtension(sock, hello);
      else if (hello.role === 'peer') this.#attachPeer(sock);
      else sock.close(4002, 'unknown role');
    });
  }

  #attachExtension(sock, hello) {
    if (this.extension && this.extension !== sock) this.extension.close(4003, 'replaced');
    this.extension = sock;
    this.log(`extension connected (v${hello.version ?? '?'})`);
    this.emit('extension');
    sock.send(JSON.stringify({ type: 'welcome' }));
    sock.on('message', (data) => {
      const msg = parse(data);
      if (msg?.type === 'response') this.#settle(msg);
    });
    sock.on('close', () => {
      if (this.extension !== sock) return;
      this.extension = null;
      this.log('extension disconnected');
      for (const id of [...this.pending.keys()]) {
        this.#settle({ id, error: 'Chrome extension disconnected before replying' });
      }
    });
  }

  #attachPeer(sock) {
    sock.send(JSON.stringify({ type: 'welcome' }));
    sock.on('message', async (data) => {
      const msg = parse(data);
      if (msg?.type !== 'request') return;
      try {
        await this.#waitForExtension();
        this.pending.set(msg.id, { peer: sock });
        this.extension.send(JSON.stringify(msg));
      } catch (err) {
        sock.send(JSON.stringify({ type: 'response', id: msg.id, error: err.message }));
      }
    });
    sock.on('close', () => {
      for (const [id, entry] of this.pending) if (entry.peer === sock) this.pending.delete(id);
    });
  }

  #startPeer() {
    return new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://${this.host}:${this.port}`);
      let welcomed = false;
      sock.once('error', (err) => {
        if (!welcomed) reject(err);
      });
      sock.on('open', () => sock.send(JSON.stringify({ type: 'hello', role: 'peer', token: this.token })));
      sock.on('message', (data) => {
        const msg = parse(data);
        if (msg?.type === 'welcome' && !welcomed) {
          welcomed = true;
          this.hub = sock;
          this.mode = 'peer';
          this.log('connected to hub as peer');
          resolve();
        } else if (msg?.type === 'response') {
          this.#settle(msg);
        }
      });
      sock.on('close', (code, reason) => {
        if (!welcomed) {
          reject(new Error(`hub refused connection (${code} ${reason})`));
          return;
        }
        this.hub = null;
        this.mode = null;
        this.log('hub went away');
        for (const id of [...this.pending.keys()]) this.#settle({ id, error: 'hub process exited before replying' });
        // Try to take over the port so the extension has somewhere to reconnect.
        setTimeout(() => this.ensure().catch((err) => this.log(`takeover failed: ${err.message}`)), 200 + Math.random() * 800);
      });
    });
  }

  #waitForExtension() {
    if (this.extension) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('extension', onConnect);
        reject(
          new Error(
            'Chrome extension is not connected. Make sure Chrome is running, the "Chrome Tabs MCP" extension is loaded, ' +
              'and its options page has the token printed by `node src/index.js token`.',
          ),
        );
      }, this.extensionWaitMs);
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('extension', onConnect);
    });
  }

  #settle(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (entry.peer) {
      if (entry.peer.readyState === WebSocket.OPEN) entry.peer.send(JSON.stringify({ type: 'response', ...msg }));
      return;
    }
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error));
    else entry.resolve(msg.result);
  }

  /** Sends one operation to the extension and resolves with its result. */
  async request(op, params = {}) {
    await this.ensure();
    if (this.mode === 'hub') await this.#waitForExtension();
    const target = this.mode === 'hub' ? this.extension : this.hub;
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`"${op}" timed out after ${this.requestTimeoutMs / 1000}s`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      target.send(JSON.stringify({ type: 'request', id, op, params }));
    });
  }

  async close() {
    this.hub?.removeAllListeners('close');
    this.hub?.close();
    for (const client of this.wss?.clients ?? []) client.terminate();
    await new Promise((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.mode = null;
  }
}

function parse(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}
