import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecuteBackgroundScriptTool } from '../build/tools/execute-background-script-tool.js';

/** A ScriptService that reports a clean, successful run. */
function makeScriptService(output = '0 records found', overrides = {}) {
  return {
    async executeBackgroundScript() {
      return {
        success: true,
        output,
        executionTime: 1200,
        executionPath: 'sys_trigger',
        outcome: 'completed',
        executionState: 'completed',
		instanceName: 'dev',
		...overrides,
      };
    },
    getExecutionTransportStatus() {
      return {
        transport: 'sys_trigger',
        configuredPath: null,
        usesCompanionEndpoint: false,
        fallbackOnFailure: false,
        privilegeModel: 'scheduled_job_context',
        diagnostic: 'test',
      };
    },
  };
}

/**
 * A SchemaService stub keyed by table name. `profiles` maps table -> the access
 * profile getTableAccessProfile should return (or null to simulate a failed probe).
 */
function makeSchemaService(profiles) {
  const calls = [];
  return {
    calls,
    async getTableAccessProfile(table) {
      calls.push(table);
      return Object.hasOwn(profiles, table) ? profiles[table] : { exists: true, readAccess: true };
    },
    async validateFields() {
      return { unknown: [] };
    },
    async suggestTableName() {
      return undefined;
    },
  };
}

const SCRIPT = `
  var gr = new GlideRecord('sn_ai_observe_scoring_provider');
  gr.query();
  gs.info('rows: ' + gr.getRowCount());
`;

test('a read_access=false table produces a visibility warning marking the result inconclusive', async () => {
  // The original failure: a global-scope script read this table, returned zero
  // rows, reported success, and the emptiness was believed. The warning is the
  // only thing distinguishing "no rows exist" from "this scope cannot see them".
  const schemaService = makeSchemaService({
    sn_ai_observe_scoring_provider: {
      exists: true,
      wsAccess: false,
      readAccess: false,
      owningScope: { sysId: 'abc', name: 'sn_ai_observe' },
    },
  });
  const tool = createExecuteBackgroundScriptTool(makeScriptService(), schemaService);

  const res = await tool.handler({ script: SCRIPT });

  const warnings = res.structuredContent.visibilityWarnings;
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].table, 'sn_ai_observe_scoring_provider');
  assert.equal(warnings[0].emptyResultIsConclusive, false);
  assert.match(warnings[0].reason, /read_access/);
  assert.match(warnings[0].reason, /sn_ai_observe/);
});

test('the warning is surfaced in the summary text, not just the structured body', async () => {
  // A successful run is exactly when a silent zero looks like a real answer, so
  // the caveat has to appear where the result is read, not only in a side field.
  const schemaService = makeSchemaService({
    sn_ai_observe_scoring_provider: { exists: true, wsAccess: false, readAccess: false },
  });
  const tool = createExecuteBackgroundScriptTool(makeScriptService(), schemaService);

  const res = await tool.handler({ script: SCRIPT });

  const text = res.content.map((c) => c.text).join(' ');
  assert.match(text, /not conclusive|NOT conclusive/i);
  assert.match(text, /sn_ai_observe_scoring_provider/);
});

test('the warning never blocks execution — the script still runs and returns output', async () => {
  // Static analysis cannot know a cross-scope read was invalid, and legitimate
  // scripts do read tables they can see. Warn, do not block.
  const schemaService = makeSchemaService({
    sn_ai_observe_scoring_provider: { exists: true, wsAccess: false, readAccess: false },
  });
  const tool = createExecuteBackgroundScriptTool(makeScriptService('rows: 0'), schemaService);

  const res = await tool.handler({ script: SCRIPT });

  assert.equal(res.structuredContent.success, true);
  assert.equal(res.structuredContent.output, 'rows: 0');
  assert.notEqual(res.isError, true);
});

test('a normally readable table produces no visibility warning', async () => {
  const schemaService = makeSchemaService({
    incident: { exists: true, wsAccess: true, readAccess: true },
  });
  const tool = createExecuteBackgroundScriptTool(makeScriptService(), schemaService);

  const res = await tool.handler({
    script: "var gr = new GlideRecord('incident'); gr.query();",
  });

  assert.equal(res.structuredContent.visibilityWarnings, undefined);
  const text = res.content.map((c) => c.text).join(' ');
  assert.doesNotMatch(text, /WARNING: scope-restricted/);
});

test('an unknown read_access stays silent rather than warning on every table', async () => {
  // A warning on every table whose metadata we merely failed to read would be
  // noise; the schema pre-flight already reports unresolvable tables.
  const schemaService = makeSchemaService({
    x_mystery: { exists: true, wsAccess: false, readAccess: undefined },
  });
  const tool = createExecuteBackgroundScriptTool(makeScriptService(), schemaService);

  const res = await tool.handler({
    script: "var gr = new GlideRecord('x_mystery'); gr.query();",
  });

  assert.equal(res.structuredContent.visibilityWarnings, undefined);
});

test('a failed access probe never interferes with execution', async () => {
  const schemaService = {
    async getTableAccessProfile() {
      throw new Error('probe exploded');
    },
    async validateFields() {
      return { unknown: [] };
    },
    async suggestTableName() {
      return undefined;
    },
  };
  const tool = createExecuteBackgroundScriptTool(makeScriptService('ok'), schemaService);

  const res = await tool.handler({ script: SCRIPT });

  assert.equal(res.structuredContent.success, true);
  assert.equal(res.structuredContent.visibilityWarnings, undefined);
});

test('a table the script never references is not probed', async () => {
  const schemaService = makeSchemaService({});
  const tool = createExecuteBackgroundScriptTool(makeScriptService(), schemaService);

  await tool.handler({ script: "var gr = new GlideRecord('incident'); gr.query();" });

  assert.deepEqual(schemaService.calls, ['incident']);
});

test('a write-only GlideRecord does not produce a read-visibility warning', async () => {
  const schemaService = makeSchemaService({
    x_acme_widget: {
      exists: true,
      wsAccess: false,
      readAccess: false,
      owningScope: { sysId: 'abc', name: 'x_acme' },
    },
  });
  const tool = createExecuteBackgroundScriptTool(makeScriptService('created'), schemaService);

  const res = await tool.handler({
    script:
      "var gr = new GlideRecord('x_acme_widget'); gr.initialize(); gr.setValue('name', 'x'); gr.insert();",
    allowWrites: true,
  });

  assert.equal(res.structuredContent.visibilityWarnings, undefined);
  assert.deepEqual(schemaService.calls, []);
});

test('a reported runtime scope suppresses a matching owning-scope warning', async () => {
  const schemaService = makeSchemaService({
    sn_ai_observe_scoring_provider: {
      exists: true,
      wsAccess: false,
      readAccess: false,
      owningScope: { sysId: 'abc', name: 'sn_ai_observe' },
    },
  });
  const service = makeScriptService('rows: 1', {
    runtimeIdentity: { userName: 'system', scopeName: 'sn_ai_observe' },
  });

  const res = await createExecuteBackgroundScriptTool(service, schemaService).handler({ script: SCRIPT });

  assert.equal(res.structuredContent.visibilityWarnings, undefined);
  assert.equal(res.structuredContent.runtimeContext.observedIdentity.scopeName, 'sn_ai_observe');
});

test('a differing reported runtime scope is attached without guessing global scope', async () => {
  const schemaService = makeSchemaService({
    sn_ai_observe_scoring_provider: {
      exists: true,
      wsAccess: false,
      readAccess: false,
      owningScope: { sysId: 'abc', name: 'sn_ai_observe' },
    },
  });
  const service = makeScriptService('rows: 0', {
    runtimeIdentity: { userName: 'system', scopeName: 'x_other' },
  });

  const res = await createExecuteBackgroundScriptTool(service, schemaService).handler({ script: SCRIPT });
  const warning = res.structuredContent.visibilityWarnings[0];

  assert.equal(warning.executionScope, 'x_other');
  assert.doesNotMatch(warning.reason, /runs in global scope/i);
});

test('transport health is recorded under the resolved instance, not the literal default key', async () => {
  const { resetTransportHealth, transportHealth } = await import('../build/utils/transport-health.js');
  resetTransportHealth();
  const service = makeScriptService('ok', {
    instanceName: 'named-default',
    timings: {
      totalDurationMs: 100,
      setupDurationMs: 10,
      pollingDurationMs: 60,
      payloadReadDurationMs: 10,
      cleanupDurationMs: 20,
      pollCount: 1,
    },
  });

  await createExecuteBackgroundScriptTool(service).handler({ script: "gs.info('ok')" });

  assert.equal(transportHealth('default'), undefined);
  assert.equal(transportHealth('named-default').samples, 1);
  resetTransportHealth();
});

test('resultMode json rejects an oversized final JSON line before parsing it', async () => {
  const giant = JSON.stringify({ success: true, payload: 'x'.repeat(21_000) });
  const tool = createExecuteBackgroundScriptTool(makeScriptService(giant));

  const res = await tool.handler({ script: "gs.info('{}')", resultMode: 'json' });

  assert.equal(res.isError, true);
  assert.match(res.structuredContent.warning, /maximum is 20000/i);
  assert.equal(res.structuredContent.applicationResult, undefined);
});
