// Pure planning functions. They read a state snapshot from the extension's `listState` op and
// return what to change; the extension does the changing.
//
// State shape:
//   { lastFocusedWindowId, windows: [{ id, focused, incognito, tabs: [Tab], groups: [Group] }] }
//   Tab:   { id, windowId, index, title, url, pinned, active, audible, discarded, groupId, lastAccessed }
//   Group: { id, windowId, title, color, collapsed }
// A layout (what applyLayout takes):
//   { windowId, groups: [{ groupId?, title, color?, collapsed?, tabIds }], ungrouped: [tabId], ungroupedPosition }

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
const NO_GROUP = -1;

export function findWindow(state, windowId) {
  const id = windowId ?? state.lastFocusedWindowId ?? state.windows[0]?.id;
  const win = state.windows.find((w) => w.id === id);
  if (!win) throw new Error(`No browser window with id ${id}. Call list_tabs to see window ids.`);
  return win;
}

export function normalizeUrl(url, { ignoreQuery = false, ignoreHash = true } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  const search = ignoreQuery ? '' : u.search;
  const hash = ignoreHash ? '' : u.hash;
  return `${u.protocol}//${u.host}${path}${search}${hash}`;
}

/** Ranks which copy of a duplicate to keep: pinned, then active, then grouped, then most recently used. */
function keepScore(tab) {
  return [tab.pinned ? 1 : 0, tab.active ? 1 : 0, tab.groupId !== NO_GROUP ? 1 : 0, tab.lastAccessed ?? 0, -tab.index];
}

function compareScores(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] - a[i];
  return 0;
}

/**
 * Finds tabs whose normalized URLs match. scope 'all' compares across windows; 'window' only within each.
 * Returns [{ url, keep: Tab, close: [Tab] }].
 */
export function findDuplicates(state, { windowId, scope = 'all', ignoreQuery = false, ignoreHash = true } = {}) {
  const windows = windowId == null ? state.windows : [findWindow(state, windowId)];
  const buckets = new Map();
  for (const win of windows) {
    for (const tab of win.tabs) {
      if (!tab.url) continue;
      const url = normalizeUrl(tab.url, { ignoreQuery, ignoreHash });
      const key = scope === 'window' ? `${win.id} ${url}` : `${win.incognito ? 'i' : 'n'} ${url}`;
      if (!buckets.has(key)) buckets.set(key, { url, tabs: [] });
      buckets.get(key).tabs.push(tab);
    }
  }
  const result = [];
  for (const { url, tabs } of buckets.values()) {
    if (tabs.length < 2) continue;
    const ranked = [...tabs].sort((a, b) => compareScores(keepScore(a), keepScore(b)));
    // Never close a pinned tab, even if another pinned copy is kept.
    const close = ranked.slice(1).filter((t) => !t.pinned);
    if (close.length) result.push({ url, keep: ranked[0], close });
  }
  return result;
}

function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url ?? '';
  }
}

const SORT_KEYS = {
  domain: (t) => [hostname(t.url), t.url ?? ''],
  url: (t) => [t.url ?? ''],
  title: (t) => [(t.title ?? '').toLowerCase(), t.url ?? ''],
  lastAccessed: (t) => [t.lastAccessed ?? 0],
};

export function sortTabIds(tabs, by = 'domain', order = 'asc') {
  const keyOf = SORT_KEYS[by];
  if (!keyOf) throw new Error(`Unknown sort key "${by}". Use one of: ${Object.keys(SORT_KEYS).join(', ')}`);
  const dir = order === 'desc' ? -1 : 1;
  return [...tabs]
    .sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -dir;
        if (ka[i] > kb[i]) return dir;
      }
      return a.index - b.index; // stable on ties
    })
    .map((t) => t.id);
}

/** The window's current arrangement expressed as a layout. */
export function currentLayout(win) {
  const groups = [];
  const byId = new Map();
  const ungrouped = [];
  let firstGroupedIndex = Infinity;
  let firstUngroupedIndex = Infinity;
  for (const tab of win.tabs) {
    if (tab.pinned) continue;
    if (tab.groupId === NO_GROUP) {
      ungrouped.push(tab.id);
      firstUngroupedIndex = Math.min(firstUngroupedIndex, tab.index);
      continue;
    }
    firstGroupedIndex = Math.min(firstGroupedIndex, tab.index);
    if (!byId.has(tab.groupId)) {
      const meta = win.groups.find((g) => g.id === tab.groupId) ?? {};
      const group = { groupId: tab.groupId, title: meta.title ?? '', color: meta.color, collapsed: meta.collapsed, tabIds: [] };
      byId.set(tab.groupId, group);
      groups.push(group);
    }
    byId.get(tab.groupId).tabIds.push(tab.id);
  }
  return {
    windowId: win.id,
    groups,
    ungrouped,
    ungroupedPosition: firstUngroupedIndex < firstGroupedIndex ? 'start' : 'end',
  };
}

/**
 * Builds a sorted layout for one window.
 * scope: 'ungrouped' sorts only ungrouped tabs, 'within_groups' only tabs inside each group, 'all' both.
 * sortGroups: 'none' keeps group order, 'title' orders groups by title.
 */
export function sortLayout(win, { by = 'domain', order = 'asc', scope = 'all', sortGroups = 'none' } = {}) {
  const layout = currentLayout(win);
  const tabById = new Map(win.tabs.map((t) => [t.id, t]));
  const sortIds = (ids) => sortTabIds(ids.map((id) => tabById.get(id)), by, order);
  if (scope === 'within_groups' || scope === 'all') {
    for (const group of layout.groups) group.tabIds = sortIds(group.tabIds);
  }
  if (scope === 'ungrouped' || scope === 'all') layout.ungrouped = sortIds(layout.ungrouped);
  if (sortGroups === 'title') {
    layout.groups.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
  }
  return layout;
}

/**
 * Checks a layout an agent wrote and fills in what it left out, so applying it never strands a tab.
 * - Tabs named twice, unknown, or pinned are errors.
 * - A group without groupId reuses an existing group in the window with the same title.
 * - Unmentioned tabs stay where they were: in their group if that group is in the plan, else in a
 *   leftover group appended after the planned ones, else ungrouped.
 * Returns { layout, warnings }.
 */
export function resolveLayout(state, input) {
  const win = findWindow(state, input.windowId);
  const allTabs = new Map(state.windows.flatMap((w) => w.tabs.map((t) => [t.id, t])));
  const warnings = [];
  const seen = new Set();

  const claim = (id, where) => {
    const tab = allTabs.get(id);
    if (!tab) throw new Error(`Tab ${id} (in ${where}) does not exist. Call list_tabs for current ids.`);
    if (tab.pinned) throw new Error(`Tab ${id} is pinned; pinned tabs cannot be grouped or reordered here.`);
    if (seen.has(id)) throw new Error(`Tab ${id} appears more than once in the layout.`);
    seen.add(id);
    if (tab.windowId !== win.id) warnings.push(`Tab ${id} will move from window ${tab.windowId} to window ${win.id}.`);
  };

  const usedGroupIds = new Set();
  const groups = [];
  for (const g of input.groups ?? []) {
    const tabIds = [...(g.tabIds ?? [])];
    tabIds.forEach((id) => claim(id, `group "${g.title}"`));
    let groupId = g.groupId ?? null;
    if (groupId != null && !win.groups.some((x) => x.id === groupId)) {
      warnings.push(`Group ${groupId} is not in window ${win.id}; a new group "${g.title}" will be created.`);
      groupId = null;
    }
    if (groupId == null && g.title) {
      const match = win.groups.find(
        (x) => !usedGroupIds.has(x.id) && x.title.trim().toLowerCase() === g.title.trim().toLowerCase(),
      );
      if (match) groupId = match.id;
    }
    if (groupId != null) {
      if (usedGroupIds.has(groupId)) throw new Error(`Group ${groupId} is used by more than one planned group.`);
      usedGroupIds.add(groupId);
    }
    if (g.color && !GROUP_COLORS.includes(g.color)) throw new Error(`Unknown color "${g.color}". Use: ${GROUP_COLORS.join(', ')}`);
    groups.push({ groupId, title: g.title ?? '', color: g.color, collapsed: g.collapsed, tabIds });
  }

  const ungrouped = [...(input.ungrouped ?? [])];
  ungrouped.forEach((id) => claim(id, 'ungrouped'));

  // Keep unmentioned tabs of this window.
  const leftovers = new Map();
  const unmentioned = [];
  for (const tab of win.tabs) {
    if (tab.pinned || seen.has(tab.id)) continue;
    unmentioned.push(tab.id);
    if (tab.groupId === NO_GROUP) {
      ungrouped.push(tab.id);
      continue;
    }
    const planned = groups.find((g) => g.groupId === tab.groupId);
    if (planned) {
      planned.tabIds.push(tab.id);
      continue;
    }
    if (!leftovers.has(tab.groupId)) {
      const meta = win.groups.find((x) => x.id === tab.groupId) ?? {};
      leftovers.set(tab.groupId, { groupId: tab.groupId, title: meta.title ?? '', color: meta.color, collapsed: meta.collapsed, tabIds: [] });
    }
    leftovers.get(tab.groupId).tabIds.push(tab.id);
  }
  if (unmentioned.length) warnings.push(`${unmentioned.length} tab(s) not in the plan were kept where they were: ${unmentioned.join(', ')}.`);

  return {
    layout: {
      windowId: win.id,
      groups: [...groups, ...leftovers.values()].filter((g) => g.tabIds.length),
      ungrouped,
      ungroupedPosition: input.ungroupedPosition ?? 'end',
    },
    warnings,
  };
}

function ago(ms, now) {
  if (!ms) return '';
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clip(text, max) {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Compact, token-cheap text view of the tabs, in on-screen order. */
export function formatState(state, { windowId, now = Date.now(), maxUrl = 140 } = {}) {
  const windows = windowId == null ? state.windows : [findWindow(state, windowId)];
  const lines = [];
  for (const win of windows) {
    const marks = [win.id === state.lastFocusedWindowId ? 'last focused' : null, win.incognito ? 'incognito' : null].filter(Boolean);
    lines.push(`Window ${win.id}${marks.length ? ` (${marks.join(', ')})` : ''}: ${win.tabs.length} tabs, ${win.groups.length} groups`);
    let section = null;
    for (const tab of win.tabs) {
      const next = tab.pinned ? 'pinned' : tab.groupId === NO_GROUP ? 'ungrouped' : `g${tab.groupId}`;
      if (next !== section) {
        section = next;
        if (next.startsWith('g')) {
          const g = win.groups.find((x) => x.id === tab.groupId) ?? {};
          lines.push(`  group ${tab.groupId} "${g.title ?? ''}" (${g.color ?? '?'}${g.collapsed ? ', collapsed' : ''}):`);
        } else {
          lines.push(`  ${next}:`);
        }
      }
      const flags = [tab.active && 'active', tab.audible && 'audible', tab.discarded && 'asleep', ago(tab.lastAccessed, now)].filter(Boolean);
      lines.push(`    [${tab.id}] ${clip(tab.title, 90)} | ${clip(tab.url, maxUrl)}${flags.length ? ` | ${flags.join(', ')}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
