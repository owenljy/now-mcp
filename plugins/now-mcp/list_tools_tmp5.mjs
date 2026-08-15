import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENV = {
  ...process.env,
  SERVICENOW_CONFIG_PATH: 'config/sn-credential.example.yaml',
  SERVICENOW_FOLLOW_NOW_SDK: 'false',
};

const transport = new StdioClientTransport({
  command: 'node',
  args: ['build/index.js'],
  cwd: process.cwd(),
  env: SERVER_ENV,
});

const client = new Client({ name: 'inspect', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();

const t = tools.find(x => x.name === 'sn_diff_records');
console.log(JSON.stringify(t.inputSchema, null, 2));
const t2 = tools.find(x => x.name === 'sn_create_records');
console.log('=== batch create ===');
console.log(JSON.stringify(t2.inputSchema, null, 2));

await client.close().catch(() => {});
await transport.close().catch(() => {});
process.exit(0);
