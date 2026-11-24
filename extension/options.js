const tokenInput = document.getElementById('token');
const portInput = document.getElementById('port');
const statusEl = document.getElementById('status');

const LABELS = {
  connected: 'Connected to the MCP server.',
  waiting: 'Waiting for the MCP server. It starts when Claude Code starts.',
  'no-token': 'Missing or wrong token.',
};

async function showStatus() {
  const { status } = await chrome.storage.session.get('status');
  statusEl.textContent = LABELS[status] ?? '';
}

chrome.storage.local.get(['token', 'port']).then(({ token = '', port = 17373 }) => {
  tokenInput.value = token;
  portInput.value = port;
});

document.getElementById('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ token: tokenInput.value.trim(), port: Number(portInput.value) || 17373 });
  statusEl.textContent = 'Saved. Connecting…';
});

chrome.storage.onChanged.addListener((changes, area) => area === 'session' && 'status' in changes && showStatus());
showStatus();
