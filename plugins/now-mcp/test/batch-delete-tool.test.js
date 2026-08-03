import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BATCH_DELETE_TOOL, createBatchDeleteTool } from '../build/tools/batch-delete-tool.js';

/** Mock MCP server whose elicitInput simulates the user accepting or declining. */
function makeServer(accept) {
  const calls = [];
  return {
    calls,
    async elicitInput(request) {
      calls.push(request);
      return { action: accept ? 'accept' : 'decline', content: { confirmed: accept } };
    },
  };
}

const sysIds = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];

test('sn_batch_delete description carries the hard-delete warning', () => {
  assert.match(BATCH_DELETE_TOOL.description, /permanent hard delete/i);
  assert.match(BATCH_DELETE_TOOL.description, /no trash\/undo/i);
});

test('batch delete requests exactly one confirmation for the whole batch', async () => {
  let deleteCalls = 0;
  const batchService = {
    async batchDelete(tableName, ids) {
      deleteCalls++;
      return {
        success: true,
        successCount: ids.length,
        failureCount: 0,
        results: ids.map((sysId, index) => ({ index, success: true, sysId })),
      };
    },
  };
  const server = makeServer(true);

  const res = await createBatchDeleteTool(batchService).handler(
    { tableName: 'incident', sysIds },
    server,
  );

  assert.equal(server.calls.length, 1, 'expected exactly one elicitation, not one per record');
  assert.equal(deleteCalls, 1);
  assert.equal(res.structuredContent.summary.successCount, 3);
});

test('declining the confirmation aborts the whole batch (no delete calls made)', async () => {
  let deleteCalls = 0;
  const batchService = {
    async batchDelete() {
      deleteCalls++;
      return { success: true, successCount: 0, failureCount: 0, results: [] };
    },
  };
  const server = makeServer(false);

  const res = await createBatchDeleteTool(batchService).handler(
    { tableName: 'incident', sysIds },
    server,
  );

  assert.equal(deleteCalls, 0);
  assert.match(res.content[0].text, /cancelled/i);
});

test('batch delete rejects more sys_ids than the configured cap', async () => {
  const batchService = { async batchDelete() { throw new Error('should not be called'); } };
  const tooMany = Array.from({ length: 51 }, () => 'd'.repeat(32));

  const res = await createBatchDeleteTool(batchService).handler({ tableName: 'incident', sysIds: tooMany });

  assert.equal(res.isError, true);
});
