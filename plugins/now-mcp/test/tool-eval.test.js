import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scoreTaskSet, routeAsk } from './eval/tool-eval-scorer.mjs';
import { TASKS, BEFORE_DESCRIPTIONS } from './eval/fixtures.mjs';

// Tool-selection eval harness (WS-B §4.3).
//
// A deterministic, LLM-free harness that measures whether the advertised tool
// descriptions let an agent pick the right tool and recover the key params for
// query_records / aggregate_records / get_table_schema. The same scorer runs
// over the verbose BEFORE descriptions and the trimmed AFTER (shipped)
// descriptions; the delta is the §4.1 cleanup's effect. See
// test/eval/tool-eval-scorer.mjs for the scoring design.

// AFTER descriptions are read live from the built tool modules so the harness
// stays in lock-step with shipped code.
const TOOL_MODULES = {
  sn_query_records: ['../build/tools/query-records-tool.js', 'QUERY_RECORDS_TOOL'],
  sn_aggregate_records: ['../build/tools/aggregate-records-tool.js', 'AGGREGATE_RECORDS_TOOL'],
  sn_get_table_schema: ['../build/tools/get-table-schema-tool.js', 'GET_TABLE_SCHEMA_TOOL'],
  sn_list_tables: ['../build/tools/list-tables-tool.js', 'LIST_TABLES_TOOL'],
  sn_get_choice_list: ['../build/tools/get-choice-list-tool.js', 'GET_CHOICE_LIST_TOOL'],
  sn_create_records: ['../build/tools/create-records-tool.js', 'CREATE_RECORDS_TOOL'],
  sn_update_records: ['../build/tools/update-records-tool.js', 'UPDATE_RECORDS_TOOL'],
};

async function loadDescriptor(spec) {
  const [path, exportName] = spec;
  const mod = await import(new URL(path, import.meta.url));
  const d = mod[exportName];
  return { name: d.name, title: d.title, description: d.description };
}

async function loadCandidates() {
  const out = {};
  for (const [name, spec] of Object.entries(TOOL_MODULES)) {
    out[name] = await loadDescriptor(spec);
  }
  return out;
}

test('eval: trimmed descriptions hold or improve tool-selection vs. the verbose originals', async () => {
  const after = await loadCandidates();
  const afterCandidates = Object.values(after);

  // The BEFORE set: the same candidates, but the three targets swapped back to
  // their pre-cleanup verbose descriptions. Non-target tools are constant
  // competition, so any delta is attributable to the cleanup.
  const beforeCandidates = afterCandidates.map((c) =>
    BEFORE_DESCRIPTIONS[c.name] ? { ...c, description: BEFORE_DESCRIPTIONS[c.name] } : c
  );

  const before = scoreTaskSet(TASKS, beforeCandidates);
  const afterScore = scoreTaskSet(TASKS, afterCandidates);

  // Record the before/after delta in the test output (visible in `node --test`).
  /* eslint-disable no-console */
  console.log('\n[tool-eval] tasks:', TASKS.length);
  console.log(
    '[tool-eval] BEFORE  tool-selection=%s  param-correctness=%s  combined=%s',
    before.toolSelectionRate.toFixed(3),
    before.paramCorrectnessRate.toFixed(3),
    before.combined.toFixed(3)
  );
  console.log(
    '[tool-eval] AFTER   tool-selection=%s  param-correctness=%s  combined=%s',
    afterScore.toolSelectionRate.toFixed(3),
    afterScore.paramCorrectnessRate.toFixed(3),
    afterScore.combined.toFixed(3)
  );
  console.log(
    '[tool-eval] DELTA   tool-selection=%s  combined=%s',
    (afterScore.toolSelectionRate - before.toolSelectionRate).toFixed(3),
    (afterScore.combined - before.combined).toFixed(3)
  );

  // The cleanup must not regress routing. (A trim that improves discrimination
  // raises the score; at worst it stays flat.)
  assert.ok(
    afterScore.toolSelectionRate >= before.toolSelectionRate,
    `trimmed descriptions regressed tool-selection: before=${before.toolSelectionRate} after=${afterScore.toolSelectionRate}\n` +
      JSON.stringify(afterScore.perTask.filter((t) => !t.toolOk), null, 2)
  );

  // Sanity floor: the shipped descriptions should route a clear majority of the
  // curated asks correctly.
  assert.ok(
    afterScore.toolSelectionRate >= 0.8,
    `shipped tool-selection below floor: ${afterScore.toolSelectionRate}`
  );

  // Param recovery is description-independent but must stay perfect on this set
  // (every task names a known table explicitly).
  assert.equal(afterScore.paramCorrectnessRate, 1, 'every task should recover its table param');
});

test('eval scorer is deterministic and decoupled from a single description', async () => {
  const after = await loadCandidates();
  const candidates = Object.values(after);

  // Same inputs → same routing, twice.
  const a = routeAsk('How many open incidents per assignment group?', candidates);
  const b = routeAsk('How many open incidents per assignment group?', candidates);
  assert.deepEqual(a.ranked, b.ranked, 'router must be deterministic');

  // The scorer only reads {name,title,description}; blanking a description must
  // change its routing, proving the score reflects the text, not a hard-coded map.
  const blanked = candidates.map((c) =>
    c.name === 'sn_aggregate_records' ? { ...c, description: '' } : c
  );
  const routedBlank = routeAsk('How many open incidents per assignment group?', blanked);
  assert.notEqual(
    routedBlank.tool,
    'sn_aggregate_records',
    'blanking the aggregate description should stop it from winning the count ask'
  );
});
