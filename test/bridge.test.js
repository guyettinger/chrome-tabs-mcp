import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Bridge } from '../src/bridge.js';

const HOST = '127.0.0.1';
const TOKEN = 'secret';

function fakeExtension(port, { token = TOKEN, handle = (op, params) => ({ op, params }) } = {}) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://${HOST}:${port}`);
    sock.on('open', () => sock.send(JSON.stringify({ type: 'hello', role: 'extension', token, version: 'test' })));
    sock.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.type === 'welcome') resolve(sock);
      if (msg.type === 'request') sock.send(JSON.stringify({ type: 'response', id: msg.id, result: handle(msg.op, msg.params) }));
    });
    sock.on('close', (code) => reject(new Error(`closed ${code}`)));
    sock.on('error', reject);
  });
}

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);
const quiet = { log: () => {} };

test('hub forwards requests to the extension and back', async () => {
  const port = randomPort();
  const hub = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  await hub.ensure();
  const ext = await fakeExtension(port);
  assert.deepEqual(await hub.request('listState', { a: 1 }), { op: 'listState', params: { a: 1 } });
  ext.close();
  await hub.close();
});

test('a second process becomes a peer and shares the extension', async () => {
  const port = randomPort();
  const hub = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  const peer = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  await hub.ensure();
  await peer.ensure();
  assert.equal(hub.mode, 'hub');
  assert.equal(peer.mode, 'peer');
  const ext = await fakeExtension(port);
  assert.deepEqual(await peer.request('closeTabs', { tabIds: [1] }), { op: 'closeTabs', params: { tabIds: [1] } });
  ext.close();
  await peer.close();
  await hub.close();
});

test('peer takes over the port when the hub exits', async () => {
  const port = randomPort();
  const hub = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  const peer = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  await hub.ensure();
  await peer.ensure();
  await hub.close();
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(peer.mode, 'hub');
  const ext = await fakeExtension(port);
  assert.deepEqual(await peer.request('focusTab', { tabId: 3 }), { op: 'focusTab', params: { tabId: 3 } });
  ext.close();
  await peer.close();
});

test('wrong token is rejected', async () => {
  const port = randomPort();
  const hub = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  await hub.ensure();
  await assert.rejects(fakeExtension(port, { token: 'nope' }), /closed 4001/);
  await hub.close();
});

test('request fails clearly when no extension connects', async () => {
  const port = randomPort();
  const hub = new Bridge({ host: HOST, port, token: TOKEN, extensionWaitMs: 200, ...quiet });
  await assert.rejects(hub.request('listState'), /extension is not connected/);
  await hub.close();
});

test('extension errors surface as rejections', async () => {
  const port = randomPort();
  const hub = new Bridge({ host: HOST, port, token: TOKEN, ...quiet });
  await hub.ensure();
  const sock = new WebSocket(`ws://${HOST}:${port}`);
  await new Promise((r) => sock.on('open', r));
  sock.send(JSON.stringify({ type: 'hello', role: 'extension', token: TOKEN }));
  sock.on('message', (data) => {
    const msg = JSON.parse(data);
    if (msg.type === 'request') sock.send(JSON.stringify({ type: 'response', id: msg.id, error: 'No tab with id: 9' }));
  });
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(hub.request('focusTab', { tabId: 9 }), /No tab with id: 9/);
  sock.close();
  await hub.close();
});
