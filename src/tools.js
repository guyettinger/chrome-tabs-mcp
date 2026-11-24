import { z } from 'zod';
import { GROUP_COLORS, findDuplicates, findWindow, formatState, resolveLayout, sortLayout } from './plan.js';

const color = z.enum(GROUP_COLORS);
const tabIds = z.array(z.number().int()).min(1);
const windowId = z.number().int().optional().describe('Browser window id from list_tabs. Defaults to the last focused window.');

const text = (s) => ({ content: [{ type: 'text', text: s }] });

function tool(fn) {
  return async (args) => {
    try {
      return text(await fn(args));
    } catch (err) {
      return { ...text(`Error: ${err.message}`), isError: true };
    }
  };
}

function describeApply(result, warnings = []) {
  const lines = [...warnings.map((w) => `Note: ${w}`)];
  if (!result.ok) lines.push(`Layout applied with ${result.mismatches.length} mismatch(es): ${result.mismatches.join('; ')}`);
  return lines;
}

export function registerTools(server, bridge) {
  const state = () => bridge.request('listState');

  server.registerTool(
    'list_tabs',
    {
      title: 'List tabs',
      description:
        'Lists open Chrome tabs in on-screen order, by window, with tab ids, titles, URLs, groups, and when each tab was last used. ' +
        'Call this first; every other tool takes ids from it.',
      inputSchema: { windowId: z.number().int().optional().describe('Only this window. Omit for all windows.') },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ windowId }) => formatState(await state(), { windowId })),
  );

  server.registerTool(
    'get_tab_content',
    {
      title: 'Read tab content',
      description:
        'Returns the meta description and the start of the visible text of each tab, to tell what a tab is about when its title and URL are not enough. ' +
        'Fails for chrome:// pages, the Web Store, and asleep tabs.',
      inputSchema: {
        tabIds: tabIds.max(30),
        maxChars: z.number().int().min(100).max(10_000).default(1_200),
      },
      annotations: { readOnlyHint: true },
    },
    tool(async ({ tabIds, maxChars }) => {
      const results = await bridge.request('getTabContent', { tabIds, maxChars });
      return results
        .map((r) =>
          r.error
            ? `[${r.tabId}] unavailable: ${r.error}`
            : `[${r.tabId}] ${r.title}\n${r.description ? `description: ${r.description}\n` : ''}${r.text}`,
        )
        .join('\n\n---\n\n');
    }),
  );

  server.registerTool(
    'close_duplicates',
    {
      title: 'Close duplicate tabs',
      description:
        'Finds tabs open to the same page and closes all but one copy (keeps pinned, then active, then grouped, then most recently used). ' +
        'dryRun defaults to true: show the user the list, then call again with dryRun false.',
      inputSchema: {
        windowId: z.number().int().optional().describe('Only this window. Omit to check every window.'),
        scope: z.enum(['all', 'window']).default('all').describe("'all' matches across windows; 'window' only within each window."),
        ignoreQuery: z.boolean().default(false).describe('Treat URLs differing only in ?query as the same page.'),
        ignoreHash: z.boolean().default(true).describe('Treat URLs differing only in #fragment as the same page.'),
        dryRun: z.boolean().default(true),
      },
      annotations: { destructiveHint: true },
    },
    tool(async ({ dryRun, ...opts }) => {
      const dupes = findDuplicates(await state(), opts);
      if (!dupes.length) return 'No duplicate tabs found.';
      const closeIds = dupes.flatMap((d) => d.close.map((t) => t.id));
      const listing = dupes
        .map((d) => `${d.url}\n  keep [${d.keep.id}] (window ${d.keep.windowId})\n  close ${d.close.map((t) => `[${t.id}]`).join(' ')}`)
        .join('\n');
      if (dryRun) return `Would close ${closeIds.length} tab(s):\n${listing}\n\nCall again with dryRun: false to close them.`;
      await bridge.request('closeTabs', { tabIds: closeIds });
      return `Closed ${closeIds.length} duplicate tab(s). Chrome's History > Recently closed can bring them back.\n${listing}`;
    }),
  );

  server.registerTool(
    'sort_tabs',
    {
      title: 'Sort tabs',
      description:
        'Sorts tabs in a window. scope picks what to sort: ungrouped tabs, tabs within each group, or both. Groups stay intact; ' +
        'groups are placed before ungrouped tabs unless the window already had ungrouped tabs first. Pinned tabs never move.',
      inputSchema: {
        windowId,
        by: z.enum(['domain', 'title', 'url', 'lastAccessed']).default('domain'),
        order: z.enum(['asc', 'desc']).default('asc').describe("Use 'desc' with lastAccessed for most recently used first."),
        scope: z.enum(['all', 'ungrouped', 'within_groups']).default('all'),
        sortGroups: z.enum(['none', 'title']).default('none').describe("'title' also orders the groups alphabetically."),
      },
    },
    tool(async ({ windowId, ...opts }) => {
      const s = await state();
      const win = findWindow(s, windowId);
      const result = await bridge.request('applyLayout', sortLayout(win, opts));
      return [`Sorted window ${win.id} by ${opts.by} (${opts.order}), scope ${opts.scope}.`, ...describeApply(result)].join('\n');
    }),
  );

  server.registerTool(
    'apply_layout',
    {
      title: 'Apply tab layout',
      description:
        'Arranges a window in one step: which groups exist (title, color, collapsed), which tabs go in each and in what order, and the order of ungrouped tabs. ' +
        'Use it after reasoning about how to organize tabs. Groups appear in the order given. A group without groupId reuses an existing group with the same title, else a new one is created. ' +
        'Tabs left out stay in their current group or stay ungrouped, so a partial plan is safe. Tabs from other windows are moved into this one. Pinned tabs cannot be included.',
      inputSchema: {
        windowId,
        groups: z
          .array(
            z.object({
              groupId: z.number().int().optional().describe('Existing group to reuse.'),
              title: z.string(),
              color: color.optional(),
              collapsed: z.boolean().optional(),
              tabIds: tabIds.describe('Tabs in this group, in display order.'),
            }),
          )
          .default([]),
        ungrouped: z.array(z.number().int()).default([]).describe('Tabs to take out of groups, in display order.'),
        ungroupedPosition: z.enum(['start', 'end']).default('end').describe('Put ungrouped tabs before or after the groups.'),
      },
    },
    tool(async (input) => {
      const { layout, warnings } = resolveLayout(await state(), input);
      const result = await bridge.request('applyLayout', layout);
      const summary = layout.groups.map((g, i) => `"${g.title}" ${result.groupIds?.[i] != null ? `(group ${result.groupIds[i]}) ` : ''}${g.tabIds.length} tabs`);
      return [
        `Applied layout to window ${layout.windowId}: ${summary.join(', ') || 'no groups'}; ${layout.ungrouped.length} ungrouped.`,
        ...describeApply(result, warnings),
      ].join('\n');
    }),
  );

  server.registerTool(
    'group_tabs',
    {
      title: 'Group tabs',
      description: 'Puts tabs into a group: an existing one (groupId) or a new one. Chrome moves the tabs next to each other.',
      inputSchema: {
        tabIds,
        groupId: z.number().int().optional(),
        title: z.string().optional(),
        color: color.optional(),
        collapsed: z.boolean().optional(),
      },
    },
    tool(async (args) => {
      const groupId = await bridge.request('groupTabs', args);
      return `Tabs ${args.tabIds.join(', ')} are in group ${groupId}.`;
    }),
  );

  server.registerTool(
    'ungroup_tabs',
    {
      title: 'Ungroup tabs',
      description: 'Takes tabs out of their groups. Chrome deletes a group when its last tab leaves.',
      inputSchema: { tabIds },
    },
    tool(async ({ tabIds }) => {
      await bridge.request('ungroupTabs', { tabIds });
      return `Ungrouped ${tabIds.length} tab(s).`;
    }),
  );

  server.registerTool(
    'update_group',
    {
      title: 'Update group',
      description: 'Renames, recolors, collapses, or expands a tab group.',
      inputSchema: {
        groupId: z.number().int(),
        title: z.string().optional(),
        color: color.optional(),
        collapsed: z.boolean().optional(),
      },
    },
    tool(async (args) => {
      await bridge.request('updateGroup', args);
      return `Updated group ${args.groupId}.`;
    }),
  );

  server.registerTool(
    'close_tabs',
    {
      title: 'Close tabs',
      description: 'Closes tabs. Confirm with the user first unless they already asked for these exact tabs to be closed.',
      inputSchema: { tabIds },
      annotations: { destructiveHint: true },
    },
    tool(async ({ tabIds }) => {
      await bridge.request('closeTabs', { tabIds });
      return `Closed ${tabIds.length} tab(s). Chrome's History > Recently closed can bring them back.`;
    }),
  );

  server.registerTool(
    'focus_tab',
    {
      title: 'Focus tab',
      description: 'Switches to a tab and brings its window to the front.',
      inputSchema: { tabId: z.number().int() },
    },
    tool(async ({ tabId }) => {
      await bridge.request('focusTab', { tabId });
      return `Focused tab ${tabId}.`;
    }),
  );

  server.registerPrompt(
    'organize_tabs',
    {
      title: 'Organize my tabs',
      description: 'Reason about open tabs and propose, then apply, a grouping, ordering, and cleanup.',
      argsSchema: {
        context: z.string().optional().describe('What you are working on, or how you want tabs organized.'),
      },
    },
    ({ context }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Organize my Chrome tabs.',
              context ? `Context from me: ${context}` : 'No extra context; infer what I am working on from the tabs.',
              '',
              'Steps:',
              '1. Call list_tabs.',
              '2. Where a title and URL do not say what a tab is for, call get_tab_content on just those tabs.',
              '3. Call close_duplicates with dryRun true.',
              '4. Propose a plan and wait for my approval: duplicates to close; groups by task or project (not just by site) with a short title, a color, and their tabs; ' +
                'the order of groups and of tabs inside them; and tabs that look stale (not used in days, finished searches, one-off pages) that I might close. Keep it to a compact table.',
              '5. After I approve, close what I approved, then call apply_layout once per window.',
              '6. Call list_tabs again and summarize what changed in a few lines.',
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
