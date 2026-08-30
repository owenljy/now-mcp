import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP protocol/contract test: spawn the built server over stdio using the REAL
// SDK client and assert the tool surface honours the MCP contract.
//
// The env below makes startup deterministic: point at the shipped example YAML
// so all tools register. Connection validation runs in the background against
// the placeholder creds and fails, but that's non-blocking — the handshake and
// tools/list still succeed. now-sdk follow is disabled so it can't interfere
// (follow is on by default now — must be explicitly turned off here).
const SERVER_ENV = {
  ...process.env,
  PLUGIN_ROOT: process.cwd(),
  SERVICENOW_CONFIG_PATH: 'config/sn-credential.example.yaml',
  SERVICENOW_FOLLOW_NOW_SDK: 'false',
};

const EXPECTED_CORE_TOOLS = [
  'sn_query_records',
  'sn_aggregate_records',
  'sn_create_records',
  'sn_update_records',
  'sn_delete_records',
  'sn_get_table_schema',
  'sn_list_tables',
  'sn_get_record_timeline',
  'sn_connection_status',
  'sn_reset_connection',
];

test('server advertises a spec-compliant tool list over MCP stdio', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['scripts/launch.mjs'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });

  const client = new Client(
    { name: 'protocol-contract-test', version: '1.0.0' },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    assert.ok(Array.isArray(tools), 'listTools() must return a tools array');
    assert.ok(tools.length > 0, 'server should advertise at least one tool');

    // Every expected core tool must be present.
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of EXPECTED_CORE_TOOLS) {
      assert.ok(byName.has(name), `expected core tool "${name}" to be advertised`);
    }

    // A call that omits `instance` is resolved once at the tool boundary. The
    // concrete target and correlation id must be returned as result metadata.
    const status = await client.callTool({ name: 'sn_connection_status', arguments: {} });
    assert.equal(status._meta.instance, 'dev');
    assert.match(status._meta.operationId, /^[0-9a-f-]{36}$/i);
    assert.equal(typeof status._meta.durationMs, 'number');

    // Every advertised tool must satisfy the MCP tool contract.
    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.name.length > 0, `tool name must be non-empty: ${JSON.stringify(tool)}`);

      assert.equal(typeof tool.description, 'string', `tool "${tool.name}" must have a string description`);
      assert.ok(tool.description.length > 0, `tool "${tool.name}" must have a non-empty description`);

      assert.ok(
        tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema),
        `tool "${tool.name}" must have an object inputSchema`
      );

      // WS-A: every tool now advertises a structured-output schema.
      assert.ok(
        tool.outputSchema && typeof tool.outputSchema === 'object' && !Array.isArray(tool.outputSchema),
        `tool "${tool.name}" must have an object outputSchema`
      );
    }

    // Annotations are optional in the spec and the SDK may strip them; only
    // assert their semantics when they are actually exposed.
    const queryTool = byName.get('sn_query_records');
    if (queryTool && queryTool.annotations) {
      assert.equal(
        queryTool.annotations.readOnlyHint,
        true,
        'sn_query_records should be annotated readOnlyHint=true'
      );
    }

    const deleteTool = byName.get('sn_delete_records');
    if (deleteTool && deleteTool.annotations) {
      assert.equal(
        deleteTool.annotations.destructiveHint,
        true,
        'sn_delete_records should be annotated destructiveHint=true'
      );
    }
  } finally {
    // Always tear down so no subprocess leaks, even on assertion failure.
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('server advertises the logging capability and a titled serverInfo', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });

  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // The initialize result must advertise the `logging` capability so clients
    // know they can call logging/setLevel and expect notifications/message.
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities && typeof capabilities === 'object', 'server must report capabilities');
    assert.ok(capabilities.logging, 'server must advertise the logging capability');

    // serverInfo (the Implementation the server reports at initialize) must
    // carry a human-facing `title` in addition to name/version.
    const info = client.getServerVersion();
    assert.ok(info && typeof info === 'object', 'server must report serverInfo');
    assert.equal(typeof info.name, 'string');
    assert.ok(info.name.length > 0, 'serverInfo.name must be non-empty');
    assert.equal(typeof info.title, 'string', 'serverInfo must carry a string title');
    assert.ok(info.title.length > 0, 'serverInfo.title must be non-empty');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('every advertised tool carries an openWorldHint annotation', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });

  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    // Every tool must ship an annotations object with a boolean openWorldHint —
    // this is how clients know whether a tool reaches an external system.
    for (const tool of tools) {
      assert.ok(
        tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations),
        `tool "${tool.name}" must carry an annotations object`
      );
      assert.equal(
        typeof tool.annotations.openWorldHint,
        'boolean',
        `tool "${tool.name}" must annotate openWorldHint as a boolean`
      );
    }

    // The existing safety-hint semantics still hold, now unconditionally.
    const queryTool = byName.get('sn_query_records');
    assert.ok(queryTool && queryTool.annotations, 'sn_query_records must carry annotations');
    assert.equal(
      queryTool.annotations.readOnlyHint,
      true,
      'sn_query_records should be annotated readOnlyHint=true'
    );

    const deleteTool = byName.get('sn_delete_records');
    assert.ok(deleteTool && deleteTool.annotations, 'sn_delete_records must carry annotations');
    assert.equal(
      deleteTool.annotations.destructiveHint,
      true,
      'sn_delete_records should be annotated destructiveHint=true'
    );

    // A live-instance tool reaches an external ServiceNow instance → openWorld.
    assert.equal(
      queryTool.annotations.openWorldHint,
      true,
      'sn_query_records reaches a live instance → openWorldHint=true'
    );

    // sdk_status is only advertised when now-sdk is on PATH; when present it is a
    // local, closed-world probe → openWorldHint=false.
    const sdkStatus = byName.get('sn_sdk_status');
    if (sdkStatus) {
      assert.ok(sdkStatus.annotations, 'sn_sdk_status must carry annotations');
      assert.equal(
        sdkStatus.annotations.openWorldHint,
        false,
        'sn_sdk_status is a local probe → openWorldHint=false'
      );
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('logging/setLevel resolves over MCP stdio', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });

  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // Since the server advertises the logging capability, a setLevel request
    // must resolve without a protocol error (no live instance required).
    await client.setLoggingLevel('debug');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('malformed tool input returns isError, not a protocol throw', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });

  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // get_table_schema requires a string `tableName`; passing the wrong type
    // must surface as a self-correctable tool error, NOT a JSON-RPC protocol
    // throw on the client. (SEP-1303: McpServer validates and wraps it.)
    const result = await client.callTool({
      name: 'sn_get_table_schema',
      arguments: { tableName: 12345 },
    });

    assert.equal(result.isError, true, 'malformed input should yield isError:true');
    assert.ok(Array.isArray(result.content) && result.content.length > 0, 'error result should carry content');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('server advertises resources and prompts over MCP stdio', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });
  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // Resources: the static instances resource + the schema template.
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === 'servicenow://instances'), 'expected servicenow://instances resource');

    const { resourceTemplates } = await client.listResourceTemplates();
    assert.ok(
      resourceTemplates.some((t) => t.uriTemplate === 'servicenow://schema/{table}'),
      'expected the servicenow://schema/{table} resource template'
    );

    // Prompts: the canned workflows.
    const { prompts } = await client.listPrompts();
    const names = new Set(prompts.map((p) => p.name));
    for (const expected of ['verify_fluent_deploy', 'diagnose_deploy_failure', 'investigate_incident', 'cmdb_health_overview']) {
      assert.ok(names.has(expected), `expected prompt "${expected}"`);
    }

    // get_prompt fills the template with arguments.
    const got = await client.getPrompt({ name: 'verify_fluent_deploy', arguments: { scope: 'x_acme_app' } });
    assert.ok(got.messages.length > 0, 'getPrompt should return at least one message');
    assert.match(got.messages[0].content.text, /x_acme_app/, 'prompt should be filled with the scope argument');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('advertised surface stays within the token-economy byte ceilings', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });
  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // "Teach it once" (a description, shipped every session) must not become
    // "teach it expensively once" — no single tool description may balloon.
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const bytes = Buffer.byteLength(tool.description);
      assert.ok(
        bytes <= 2100,
        `tool "${tool.name}" description is ${bytes} bytes — over the 2,100-byte ceiling`
      );
    }

    // serverInfo.instructions ships every session too — the one gate no
    // per-call test can substitute for, since a description edit doesn't
    // move it but an instructions edit does.
    const instructions = client.getInstructions();
    if (instructions) {
      const bytes = Buffer.byteLength(instructions);
      assert.ok(bytes <= 3000, `serverInfo.instructions is ${bytes} bytes — over the 3,000-byte ceiling`);
    }

    // sn_query_records' outputSchema.properties.rows must carry format-teaching
    // text once the columnar shape exists — written so it's a vacuous pass
    // today (no `rows` key yet) and a real check from PR3 onward, so PR3 does
    // not need to add this assertion, only satisfy it.
    const queryTool = tools.find((t) => t.name === 'sn_query_records');
    assert.ok(queryTool, 'sn_query_records must be advertised');
    const rowsSchema = queryTool.outputSchema && queryTool.outputSchema.properties
      ? queryTool.outputSchema.properties.rows
      : undefined;
    if (rowsSchema) {
      assert.equal(typeof rowsSchema.description, 'string', 'rows must carry a description');
      assert.ok(rowsSchema.description.length > 0, 'rows description must be non-empty');
      assert.match(
        rowsSchema.description,
        /columns/,
        'rows description must mention "columns" so the positional contract is taught'
      );
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});

test('completions resolve for the schema-template table arg and a prompt arg', { timeout: 30000 }, async () => {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['build/index.js'],
    cwd: process.cwd(),
    env: SERVER_ENV,
  });
  const client = new Client({ name: 'protocol-contract-test', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);

    // WS-D §6.2: the servicenow://schema/{table} resource template completes
    // {table}. The instance is unreachable under the example creds, so this
    // exercises the static-fallback path — which must still return candidates.
    const tableCompletion = await client.complete({
      ref: { type: 'ref/resource', uri: 'servicenow://schema/{table}' },
      argument: { name: 'table', value: 'inc' },
    });
    assert.ok(Array.isArray(tableCompletion.completion.values), 'table completion must return a values array');
    assert.ok(tableCompletion.completion.values.length > 0, 'table completion should return at least one candidate');
    assert.ok(
      tableCompletion.completion.values.includes('incident'),
      'completing "inc" should surface the incident table'
    );

    // WS-D §6.1: the verify_fluent_deploy.scope prompt arg completes too,
    // falling back to the static scope set when the instance is unreachable.
    const scopeCompletion = await client.complete({
      ref: { type: 'ref/prompt', name: 'verify_fluent_deploy' },
      argument: { name: 'scope', value: 'glob' },
    });
    assert.ok(Array.isArray(scopeCompletion.completion.values), 'scope completion must return a values array');
    assert.ok(
      scopeCompletion.completion.values.includes('global'),
      'completing "glob" should surface the global scope'
    );

    // And the investigate_incident.number prompt arg.
    const numberCompletion = await client.complete({
      ref: { type: 'ref/prompt', name: 'investigate_incident' },
      argument: { name: 'number', value: 'INC' },
    });
    assert.ok(Array.isArray(numberCompletion.completion.values), 'number completion must return a values array');
    assert.ok(numberCompletion.completion.values.length > 0, 'number completion should return at least one candidate');
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
