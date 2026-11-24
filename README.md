# chrome-tabs-mcp

Lets Claude Code (or any MCP client) see and organize your Chrome tabs: list them, close duplicates, sort them, group them, and lay out a whole window from a plan the agent reasons out.

```
Claude Code ──stdio (MCP)──▶ src/index.js ──WebSocket 127.0.0.1:17373──▶ Chrome extension
                                                                         (chrome.tabs, chrome.tabGroups)
```

## Setup

1. Install and get the token:

   ```sh
   npm install
   node src/index.js token      # creates ~/.config/chrome-tabs-mcp/token on first run
   ```

2. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension/` folder. The options page opens; paste the token and click **Save**.

3. Register the server with Claude Code (user scope, so it works in every project):

   ```sh
   claude mcp add --scope user chrome-tabs -- node "$PWD/src/index.js"
   ```

The extension badge shows `…` while it waits for a server, nothing once connected, and `!` when the token is missing or wrong. Clicking the toolbar icon opens the options page.

## Use

Ask in plain words ("close my duplicate tabs", "sort the tabs in each group by domain", "group my ANVIL tabs"), or run the prompt:

```
/mcp__chrome-tabs__organize_tabs  I'm working on the tenancy PRs today; park everything else
```

The prompt has the agent list tabs, read the unclear ones, propose groups, order, and cleanup, wait for your approval, and then apply it.

| Tool | What it does |
| --- | --- |
| `list_tabs` | Every window's tabs in on-screen order, with ids, groups, and last-used time |
| `get_tab_content` | Meta description and start of the page text, for tabs whose title doesn't say enough |
| `close_duplicates` | Closes extra copies of the same page. Previews by default (`dryRun: true`) |
| `sort_tabs` | Sorts by domain, title, URL, or last used. `scope`: `ungrouped`, `within_groups`, or `all`; `sortGroups: title` orders the groups too |
| `apply_layout` | Arranges a window in one step from a list of groups (title, color, collapsed, tabs in order) plus ungrouped tabs |
| `group_tabs`, `ungroup_tabs`, `update_group` | Single group changes |
| `close_tabs`, `focus_tab` | Close or switch to tabs |

Closed tabs can be reopened from Chrome's **History > Recently closed**.

## How it behaves

- **Pinned tabs** are never moved, grouped, or closed as duplicates.
- **Which duplicate is kept:** pinned, then active, then grouped, then most recently used. URLs match after dropping `#fragment` and trailing slashes; `ignoreQuery: true` also drops `?query`.
- **Partial layouts are safe.** `apply_layout` keeps tabs the plan leaves out in their current group, or ungrouped. A planned group without `groupId` reuses an existing group with the same title.
- **Groups come before ungrouped tabs** after sorting or a layout, unless the window already had ungrouped tabs first (or you pass `ungroupedPosition: start`).
- **Several Claude Code sessions** can run at once. The first server process listens on the port; later ones connect to it and share the extension. When the first one exits, another takes over the port and the extension reconnects within a few seconds.

## Security

- The server only listens on `127.0.0.1`. Every connection, from the extension or another server process, must send the token from `~/.config/chrome-tabs-mcp/token` (mode 600).
- The extension asks for `<all_urls>` host access only so `get_tab_content` can read page text. Remove `host_permissions` and `scripting` from `extension/manifest.json` if you don't want that; everything else still works.
- Anyone who can read your token file can control your tabs.

## Configuration

| Env var | Default |
| --- | --- |
| `CHROME_TABS_MCP_PORT` | `17373` (set the same port on the extension's options page) |
| `CHROME_TABS_MCP_CONFIG_DIR` | `~/.config/chrome-tabs-mcp` |

## Develop

```sh
npm test
```

`src/plan.js` holds the pure logic (duplicates, sorting, layout checks) and is unit-tested. `src/bridge.js` handles the hub/peer connections and is tested with a fake extension. `extension/background.js` runs the Chrome calls; after editing it, click the reload icon on `chrome://extensions`.

Requires Chrome 121+ (for `tab.lastAccessed`) and Node 18+.
