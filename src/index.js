#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { HOST, getOrCreateToken, port, tokenPath } from './config.js';
import { registerTools } from './tools.js';

// stdout carries MCP messages, so logs go to stderr.
const log = (msg) => process.stderr.write(`[chrome-tabs-mcp] ${msg}\n`);

const token = await getOrCreateToken();

if (process.argv[2] === 'token') {
  console.log(token);
  console.error(`(stored in ${tokenPath}; port ${port})`);
  process.exit(0);
}

const bridge = new Bridge({ host: HOST, port, token, log });
const server = new McpServer({ name: 'chrome-tabs', version: '0.1.0' });
registerTools(server, bridge);
await server.connect(new StdioServerTransport());
bridge.ensure().catch((err) => log(`could not start bridge: ${err.message}`));

const shutdown = async () => {
  await bridge.close().catch(() => {});
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
