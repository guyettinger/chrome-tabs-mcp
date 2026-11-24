import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 17373;
export const HOST = '127.0.0.1';

export const port = Number(process.env.CHROME_TABS_MCP_PORT) || DEFAULT_PORT;

const configDir = process.env.CHROME_TABS_MCP_CONFIG_DIR || join(homedir(), '.config', 'chrome-tabs-mcp');
const tokenPath = join(configDir, 'token');

/** Reads the shared secret the extension and every server process use, creating it on first run. */
export async function getOrCreateToken() {
  try {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    if (token) return token;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const token = randomBytes(24).toString('base64url');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return token;
}

export { tokenPath };
