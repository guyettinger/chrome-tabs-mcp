// Connects to the local MCP server over WebSocket and runs tab operations it asks for.

const VERSION = chrome.runtime.getManifest().version;
const DEFAULT_PORT = 17373;
const RETRY_MS = 3_000;
const PING_MS = 20_000; // WebSocket traffic keeps the MV3 service worker alive (Chrome 116+)
const NO_GROUP = chrome.tabGroups.TAB_GROUP_ID_NONE;

let ws = null;
let pingTimer = null;
let retryTimer = null;

function setStatus(state) {
  const badge = { connected: ['', '#2e7d32'], waiting: ['…', '#9e9e9e'], 'no-token': ['!', '#c62828'] }[state];
  chrome.action.setBadgeText({ text: badge[0] });
  chrome.action.setBadgeBackgroundColor({ color: badge[1] });
  chrome.action.setTitle({ title: `Chrome Tabs MCP: ${state}` });
  chrome.storage.session.set({ status: state });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(retryTimer);
  const { token, port = DEFAULT_PORT } = await chrome.storage.local.get(['token', 'port']);
  if (!token) {
    setStatus('no-token');
    return;
  }
  setStatus('waiting');
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', role: 'extension', token, version: VERSION }));
  sock.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      setStatus('connected');
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'), PING_MS);
      return;
    }
    if (msg.type !== 'request') return;
    const reply = { type: 'response', id: msg.id };
    try {
      const handler = handlers[msg.op];
      if (!handler) throw new Error(`Unknown operation "${msg.op}"`);
      reply.result = await handler(msg.params ?? {});
    } catch (err) {
      reply.error = err?.message ?? String(err);
    }
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
  };
  sock.onclose = (event) => {
    clearInterval(pingTimer);
    if (ws === sock) ws = null;
    setStatus(event.code === 4001 ? 'no-token' : 'waiting');
    if (event.code !== 4001) retryTimer = setTimeout(connect, RETRY_MS);
  };
  sock.onerror = () => {}; // onclose handles retry
}

// ---- operations ----

function tabInfo(t) {
  return {
    id: t.id,
    windowId: t.windowId,
    index: t.index,
    title: t.title,
    url: t.url || t.pendingUrl || '',
    pinned: t.pinned,
    active: t.active,
    audible: !!t.audible,
    discarded: !!t.discarded,
    groupId: t.groupId,
    lastAccessed: t.lastAccessed,
  };
}

async function listState() {
  const [windows, groups, lastFocused] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.tabGroups.query({}),
    chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null),
  ]);
  return {
    lastFocusedWindowId: lastFocused?.id ?? null,
    windows: windows.map((w) => ({
      id: w.id,
      focused: w.focused,
      incognito: w.incognito,
      tabs: w.tabs.map(tabInfo).sort((a, b) => a.index - b.index),
      groups: groups
        .filter((g) => g.windowId === w.id)
        .map((g) => ({ id: g.id, windowId: g.windowId, title: g.title ?? '', color: g.color, collapsed: g.collapsed })),
    })),
  };
}

async function groupInto(tabIds, groupId, windowId) {
  if (groupId != null) {
    try {
      return await chrome.tabs.group({ tabIds, groupId });
    } catch {
      // Group vanished (e.g. its last tab was moved out); fall through and create a new one.
    }
  }
  return chrome.tabs.group({ tabIds, createProperties: windowId != null ? { windowId } : {} });
}

function groupProps({ title, color, collapsed }) {
  const props = {};
  if (title != null) props.title = title;
  if (color != null) props.color = color;
  if (collapsed != null) props.collapsed = collapsed;
  return props;
}

async function placeLayout({ windowId, groups, ungrouped, ungroupedPosition }) {
  const pinned = await chrome.tabs.query({ windowId, pinned: true });
  let cursor = pinned.length;
  const groupIds = [];

  const placeUngrouped = async () => {
    if (!ungrouped.length) return;
    await chrome.tabs.ungroup(ungrouped);
    for (const id of ungrouped) await chrome.tabs.move(id, { index: cursor++ });
  };

  if (ungroupedPosition === 'start') await placeUngrouped();
  for (const g of groups) {
    const groupId = await groupInto(g.tabIds, g.groupId, windowId);
    groupIds.push(groupId);
    await chrome.tabGroups.update(groupId, groupProps({ title: g.title, color: g.color }));
    await chrome.tabGroups.move(groupId, { index: cursor });
    for (let k = 0; k < g.tabIds.length; k++) await chrome.tabs.move(g.tabIds[k], { index: cursor + k });
    cursor += g.tabIds.length;
  }
  if (ungroupedPosition !== 'start') await placeUngrouped();
  return groupIds;
}

async function verifyLayout(layout, groupIds) {
  const expected = [];
  const push = (ids, groupId) => ids.forEach((id) => expected.push({ id, groupId }));
  if (layout.ungroupedPosition === 'start') push(layout.ungrouped, NO_GROUP);
  layout.groups.forEach((g, i) => push(g.tabIds, groupIds[i]));
  if (layout.ungroupedPosition !== 'start') push(layout.ungrouped, NO_GROUP);

  const actual = (await chrome.tabs.query({ windowId: layout.windowId, pinned: false })).sort((a, b) => a.index - b.index);
  const mismatches = [];
  expected.forEach((want, i) => {
    const got = actual[i];
    if (!got || got.id !== want.id) mismatches.push(`position ${i}: expected tab ${want.id}, found ${got?.id ?? 'nothing'}`);
    else if (got.groupId !== want.groupId) mismatches.push(`tab ${want.id}: expected group ${want.groupId}, found ${got.groupId}`);
  });
  return mismatches;
}

async function applyLayout(layout) {
  const { windowId, groups } = layout;
  const ids = [...groups.flatMap((g) => g.tabIds), ...layout.ungrouped];
  const tabs = await Promise.all(ids.map((id) => chrome.tabs.get(id)));

  const foreign = tabs.filter((t) => t.windowId !== windowId).map((t) => t.id);
  if (foreign.length) await chrome.tabs.move(foreign, { windowId, index: -1 });

  // Take tabs out of groups they are leaving first, so no group drags along tabs bound elsewhere.
  const byId = new Map(tabs.map((t) => [t.id, t]));
  const leaving = groups.flatMap((g) => g.tabIds.filter((id) => byId.get(id).groupId !== NO_GROUP && byId.get(id).groupId !== g.groupId));
  if (leaving.length) await chrome.tabs.ungroup(leaving);

  let groupIds = await placeLayout(layout);
  let mismatches = await verifyLayout(layout, groupIds);
  if (mismatches.length) {
    // Chrome sometimes resolves group membership differently mid-sequence; a second pass settles it.
    groupIds = await placeLayout({ ...layout, groups: groups.map((g, i) => ({ ...g, groupId: groupIds[i] })) });
    mismatches = await verifyLayout(layout, groupIds);
  }

  // Collapse last: collapsing earlier can switch the active tab mid-move.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].collapsed != null) await chrome.tabGroups.update(groupIds[i], { collapsed: groups[i].collapsed });
  }
  return { ok: mismatches.length === 0, mismatches, groupIds };
}

async function groupTabs({ tabIds, groupId, title, color, collapsed }) {
  const id = await groupInto(tabIds, groupId, undefined);
  const props = groupProps({ title, color, collapsed });
  if (Object.keys(props).length) await chrome.tabGroups.update(id, props);
  return id;
}

async function getTabContent({ tabIds, maxChars = 1200 }) {
  return Promise.all(
    tabIds.map(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.discarded) return { tabId, error: 'tab is asleep (discarded); open it first' };
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (max) => ({
            title: document.title,
            description:
              document.querySelector('meta[name="description"], meta[property="og:description"]')?.content?.trim() ?? '',
            text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, max),
          }),
          args: [maxChars],
        });
        return { tabId, ...result };
      } catch (err) {
        return { tabId, error: err?.message ?? String(err) };
      }
    }),
  );
}

const handlers = {
  listState,
  applyLayout,
  groupTabs,
  getTabContent,
  ungroupTabs: ({ tabIds }) => chrome.tabs.ungroup(tabIds),
  updateGroup: ({ groupId, ...rest }) => chrome.tabGroups.update(groupId, groupProps(rest)).then(() => true),
  closeTabs: ({ tabIds }) => chrome.tabs.remove(tabIds).then(() => true),
  focusTab: async ({ tabId }) => {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  },
};

// ---- lifecycle ----

chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(({ reason }) => {
  connect();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('token' in changes || 'port' in changes)) return;
  ws?.close();
  ws = null;
  connect();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
connect();
