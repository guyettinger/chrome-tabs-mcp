import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentLayout, findDuplicates, formatState, normalizeUrl, resolveLayout, sortLayout } from '../src/plan.js';

let nextId = 1;
function tab(url, extra = {}) {
  return { id: nextId++, title: url, url, pinned: false, active: false, groupId: -1, lastAccessed: 0, ...extra };
}
function win(id, tabs, groups = []) {
  tabs.forEach((t, i) => Object.assign(t, { index: i, windowId: id }));
  return { id, incognito: false, tabs, groups: groups.map((g) => ({ windowId: id, color: 'blue', collapsed: false, ...g })) };
}

test('normalizeUrl drops hash and trailing slash, keeps query unless asked', () => {
  assert.equal(normalizeUrl('https://a.com/x/#top'), 'https://a.com/x');
  assert.equal(normalizeUrl('https://a.com/?q=1'), 'https://a.com/?q=1');
  assert.equal(normalizeUrl('https://a.com/x?q=1', { ignoreQuery: true }), 'https://a.com/x');
  assert.equal(normalizeUrl('https://a.com/x#h', { ignoreHash: false }), 'https://a.com/x#h');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('findDuplicates keeps pinned, then active, then most recent; never closes pinned', () => {
  const a1 = tab('https://a.com/', { lastAccessed: 5 });
  const a2 = tab('https://a.com/#x', { lastAccessed: 9 });
  const a3 = tab('https://a.com', { active: true });
  const b1 = tab('https://b.com', { pinned: true });
  const b2 = tab('https://b.com', { pinned: true });
  const state = { windows: [win(1, [a1, a2, b1]), win(2, [a3, b2])] };
  const dupes = findDuplicates(state);
  const a = dupes.find((d) => d.url === 'https://a.com/');
  assert.equal(a.keep.id, a3.id);
  assert.deepEqual(a.close.map((t) => t.id), [a2.id, a1.id]);
  assert.equal(dupes.find((d) => d.url === 'https://b.com/'), undefined);
});

test('findDuplicates scope window ignores cross-window copies', () => {
  const state = { windows: [win(1, [tab('https://a.com')]), win(2, [tab('https://a.com')])] };
  assert.equal(findDuplicates(state, { scope: 'window' }).length, 0);
  assert.equal(findDuplicates(state, { scope: 'all' }).length, 1);
});

test('sortLayout sorts within groups and ungrouped, keeps group order unless asked', () => {
  const p = tab('https://pinned.com', { pinned: true });
  const z = tab('https://z.com', { groupId: 10 });
  const y = tab('https://www.y.com', { groupId: 10 });
  const c = tab('https://c.com', { groupId: 20 });
  const u2 = tab('https://u2.com');
  const u1 = tab('https://u1.com');
  const w = win(1, [p, z, y, c, u2, u1], [{ id: 10, title: 'Zed' }, { id: 20, title: 'Alpha' }]);

  const within = sortLayout(w, { scope: 'within_groups' });
  assert.deepEqual(within.groups.map((g) => g.tabIds), [[y.id, z.id], [c.id]]);
  assert.deepEqual(within.ungrouped, [u2.id, u1.id]);

  const all = sortLayout(w, { scope: 'all', sortGroups: 'title' });
  assert.deepEqual(all.groups.map((g) => g.title), ['Alpha', 'Zed']);
  assert.deepEqual(all.ungrouped, [u1.id, u2.id]);
  assert.equal(all.ungroupedPosition, 'end');
});

test('currentLayout notices ungrouped tabs placed before groups', () => {
  const w = win(1, [tab('https://u.com'), tab('https://g.com', { groupId: 5 })], [{ id: 5, title: 'G' }]);
  assert.equal(currentLayout(w).ungroupedPosition, 'start');
});

test('resolveLayout reuses groups by title and keeps unmentioned tabs', () => {
  const a = tab('https://a.com', { groupId: 7 });
  const b = tab('https://b.com', { groupId: 7 });
  const c = tab('https://c.com', { groupId: 8 });
  const d = tab('https://d.com');
  const e = tab('https://e.com');
  const state = { lastFocusedWindowId: 1, windows: [win(1, [a, b, c, d, e], [{ id: 7, title: 'Work' }, { id: 8, title: 'Old' }])] };

  const { layout, warnings } = resolveLayout(state, { groups: [{ title: 'work', tabIds: [d.id, a.id] }] });
  assert.equal(layout.groups[0].groupId, 7);
  assert.deepEqual(layout.groups[0].tabIds, [d.id, a.id, b.id]);
  assert.deepEqual(layout.groups[1], { groupId: 8, title: 'Old', color: 'blue', collapsed: false, tabIds: [c.id] });
  assert.deepEqual(layout.ungrouped, [e.id]);
  assert.match(warnings.join(' '), /not in the plan/);
});

test('resolveLayout rejects duplicates, unknown, and pinned tabs', () => {
  const a = tab('https://a.com');
  const p = tab('https://p.com', { pinned: true });
  const state = { lastFocusedWindowId: 1, windows: [win(1, [a, p])] };
  assert.throws(() => resolveLayout(state, { groups: [{ title: 'x', tabIds: [a.id] }], ungrouped: [a.id] }), /more than once/);
  assert.throws(() => resolveLayout(state, { groups: [{ title: 'x', tabIds: [999] }] }), /does not exist/);
  assert.throws(() => resolveLayout(state, { groups: [{ title: 'x', tabIds: [p.id] }] }), /pinned/);
  assert.throws(() => resolveLayout(state, { groups: [{ title: 'x', color: 'teal', tabIds: [a.id] }] }), /Unknown color/);
});

test('resolveLayout warns about tabs pulled from other windows', () => {
  const a = tab('https://a.com');
  const b = tab('https://b.com');
  const state = { lastFocusedWindowId: 1, windows: [win(1, [a]), win(2, [b])] };
  const { layout, warnings } = resolveLayout(state, { windowId: 1, groups: [{ title: 'All', tabIds: [a.id, b.id] }] });
  assert.deepEqual(layout.groups[0].tabIds, [a.id, b.id]);
  assert.match(warnings[0], /from window 2/);
});

test('formatState shows sections in on-screen order', () => {
  const w = win(3, [tab('https://p.com', { pinned: true }), tab('https://g.com', { groupId: 4 }), tab('https://u.com')], [{ id: 4, title: 'G' }]);
  const out = formatState({ lastFocusedWindowId: 3, windows: [w] }, { now: 0 });
  assert.match(out, /Window 3 \(last focused\): 3 tabs, 1 groups\n {2}pinned:\n.*\n {2}group 4 "G" \(blue\):\n.*\n {2}ungrouped:/);
});
