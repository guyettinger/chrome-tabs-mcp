# chrome-tabs-mcp

Ask Claude Code to tidy your Chrome tabs. It can close duplicates, sort tabs, and group them by what you're working on, across every window. For example:

```
> Group my tabs by project and close the duplicates

  Found 4 duplicates and 31 tabs across 2 windows. Proposed plan:
  - Close 4 duplicate tabs
  - "Checkout bug" (blue): 6 tabs
  - "Design review" (purple): 4 tabs
  - Leave the remaining 17 tabs ungrouped, sorted by site
  Apply it?
```

This repo has two parts that work together:
- **A Chrome extension** that can read and rearrange your tabs.
- **An MCP server** that hands those abilities to Claude Code. MCP (Model Context Protocol) is the standard way Claude Code and other AI agents call outside tools, so any MCP client can use this server.

## Set it up in about two minutes

You need Chrome 121 or later, Node 18 or later, and Claude Code.

1. Install it and print your token, a shared secret that lets the extension trust the server:

   ```sh
   git clone https://github.com/guyettinger/chrome-tabs-mcp.git
   cd chrome-tabs-mcp
   npm install
   node src/index.js token
   ```

   The first run creates the token at `~/.config/chrome-tabs-mcp/token`.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and pick the `extension/` folder. Its options page opens.
4. Paste the token and click **Save**.
5. Register the server with Claude Code for all your projects. Run this from the repo folder:

   ```sh
   claude mcp add --scope user chrome-tabs -- node "$PWD/src/index.js"
   ```

6. Restart Claude Code.

Expected result: the extension's toolbar badge is blank, which means it's connected.

| Badge | Meaning |
| ----- | ------- |
| *(blank)* | Connected |
| `…` | Waiting for the server, which starts with Claude Code |
| `!` | Token missing or wrong. Click the toolbar icon to open the options page. |

## Ask in plain words, or run the organize prompt

Ask for what you want, for example "close my duplicate tabs", "sort the tabs in each group by site", or "group my GitHub tabs by repo".

For a full cleanup, run the organize prompt with a note about what you're doing:

```
/mcp__chrome-tabs__organize_tabs  I'm fixing the checkout bug today; park everything else
```

The prompt has Claude:
1. List your tabs.
2. Read the pages whose titles don't say what they are.
3. Propose groups, an order, and tabs to close.
4. Wait for your approval.
5. Apply the plan and summarize what changed.

## What Claude can do with your tabs

| Tool | What it does |
| ---- | ------------ |
| `list_tabs` | Shows every window's tabs in on-screen order, with tab ids, groups, and when each tab was last used |
| `get_tab_content` | Reads a page's description and the start of its text, for tabs whose title doesn't say enough |
| `close_duplicates` | Closes extra copies of the same page. It shows the list first and closes only when called again with `dryRun: false` |
| `sort_tabs` | Sorts by site, title, URL, or last used. It can sort ungrouped tabs, the tabs inside each group, or both, and can order the groups by title |
| `apply_layout` | Arranges a window in one step from a layout: the groups (title, color, collapsed or not, tabs in order) and the ungrouped tabs |
| `group_tabs`, `ungroup_tabs`, `update_group` | Make a single group change |
| `close_tabs`, `focus_tab` | Close tabs, or switch to one |

## Your tabs are hard to lose

- **Pinned tabs never change.** No tool moves, groups, or closes them.
- **Closing duplicates is a preview first.** Claude shows the list before anything closes.
- **The best copy of a duplicate stays.** The order of preference is pinned, then the active tab, then a grouped one, then the most recently used. Two URLs count as the same page when they differ only by a `#fragment` or a trailing slash. Pass `ignoreQuery: true` to also ignore `?query` text.
- **A partial layout leaves the rest alone.** Tabs a layout doesn't mention stay in their current group, or stay ungrouped. A layout group with no `groupId` reuses an existing group with the same title.
- **Groups come before ungrouped tabs** after sorting or applying a layout. The exception is a window that already had its ungrouped tabs first, or a layout with `ungroupedPosition: start`.
- **Closed tabs come back** from Chrome's **History > Recently closed**.

## How the pieces connect

```
Claude Code ──starts, then sends tool calls──▶ MCP server (src/index.js)
                                                    ▲
                                connects to and     │ WebSocket on 127.0.0.1:17373
                                takes commands from │
                                                    │
                                          Chrome extension ──calls──▶ chrome.tabs, chrome.tabGroups
```

Each Claude Code session starts its own copy of the server, and all of them share the one extension. The first copy listens on the port, and later copies send their requests through it. When the first copy exits, another takes over the port, and the extension reconnects within a few seconds.

## Only your own machine can reach your tabs

- The server listens only on `127.0.0.1`, so other computers can't connect.
- Every connection, from the extension or another copy of the server, must send the token. The token file is readable only by you (mode 600).
- Anyone who can read your token file can control your tabs.
- The extension asks to access all sites only so `get_tab_content` can read page text. To drop that access, remove `host_permissions` and `scripting` from `extension/manifest.json`. Every other tool still works.

## Change the port or config folder

| Environment variable | Default |
| -------------------- | ------- |
| `CHROME_TABS_MCP_PORT` | `17373`. Set the same port on the extension's options page. |
| `CHROME_TABS_MCP_CONFIG_DIR` | `~/.config/chrome-tabs-mcp` |

## Develop

Run the tests with `npm test`.

| File | Role | Tested by |
| ---- | ---- | --------- |
| `src/plan.js` | Pure logic: finding duplicates, sorting, and checking layouts | Unit tests |
| `src/bridge.js` | Connections between the server copies and the extension | Tests with a fake extension |
| `extension/background.js` | The Chrome calls | Manual. After editing it, click the reload icon on `chrome://extensions`. |
