// =============================================================================
// !! SERVICENOW BACKGROUND SCRIPT — do NOT run with node !!
// =============================================================================
// Template: Launch an AI Agent conversation and poll for completion
// =============================================================================
// How to run:
//   1. Go to your local Glide instance (http://localhost:8080)
//   2. Navigate to: All > System Definition > Scripts - Background
//   3. Set scope to: global
//   4. Fill in the config section below and click Run
//
// Prerequisites:
//   - sn_aia (nowassist-ai-agents) >= 7.1.8
//   - Agent usecase deployed and active
//   - LLM connection configured and active
// =============================================================================

// -----------------------------------------------------------------------------
// CONFIG — fill these in before running
// -----------------------------------------------------------------------------
var USECASE_ID = 'YOUR_USECASE_ID_HERE'; // sys_id of the sn_aia_usecase record
                                          // Find it: sn_aia_usecase.list in your instance
var OBJECTIVE = 'Your objective here';   // prompt/goal for the agent to execute

// Optional: set a specific target record for context (leave empty if not needed)
var TARGET_RECORD_ID = '';   // sys_id of the record to pass as context
var TARGET_TABLE = '';       // table name, e.g. 'em_alert', 'incident'

// Optional: pass prior conversation history (sn_aia >= 6.0)
// var CONTEXT_MEMORY = JSON.stringify({
//   conversation: [
//     { from: 'You', message: 'Prior message for context' },
//   ]
// });

// Optional: request a structured JSON response (sn_aia >= 6.0)
// var STRUCTURED_OUTPUT = {
//   type: 'json_schema',
//   json_schema: {
//     schema: {
//       type: 'object',
//       properties: {
//         summary: { type: 'string' },
//         resolved: { type: 'boolean' },
//       },
//       required: ['summary', 'resolved'],
//     },
//   },
// };

// -----------------------------------------------------------------------------
// Step 1: Get admin user sys_id dynamically
// -----------------------------------------------------------------------------
var adminGr = new GlideRecord('sys_user');
adminGr.addQuery('user_name', 'admin');
adminGr.setLimit(1);
adminGr.query();
var ADMIN_USER_ID = adminGr.next()
  ? adminGr.getValue('sys_id')
  : '6816f79cc0a8016401c5a33be04be441';
gs.info('[SETUP] Running as user: ' + ADMIN_USER_ID);

// -----------------------------------------------------------------------------
// Step 2: Launch the agent
// -----------------------------------------------------------------------------
gs.info('[LAUNCH] Starting AI agent conversation...');
gs.info('[LAUNCH] Usecase: ' + USECASE_ID);
gs.info('[LAUNCH] Objective: ' + OBJECTIVE);

var util = new sn_aia.AiAgentRuntimeUtil();
var result = util.startAiAgentConversation({
  usecaseId: USECASE_ID,
  objective: OBJECTIVE,
  conversationUser: ADMIN_USER_ID,
  conversationLabel: 'Manual test — ' + USECASE_ID,
  targetRecordId: TARGET_RECORD_ID,
  targetTable: TARGET_TABLE,
  // canInteractWithUser: false — "autonomous" mode. Agent runs to completion
  // without ever pausing for user input. This is the correct value for all
  // scripted/background test runs.
  //
  // canInteractWithUser: true — "supervised" mode. Used only in the ZTSD
  // production background pattern where the agent can pause and resume when
  // a user replies asynchronously via a persistent worker session:
  //   conversationChannel: 'c81f0f9137b922109a618a6c24924b7f',
  //   inboundId: 'aia-pa-bg-provider-application',
  //   providerAppId: 'cda755bbff2132106bd0ffffffffff48',
  //   workerId: '<sn_aia_worker sys_id>',
  //   sessionId: workerId + '_' + recordId,  // stable key for resume
  // These two modes are NOT interchangeable.
  //
  // If gatherData appears with canInteractWithUser: false, the agent itself
  // contains a tool that explicitly collects user input — fix the agent prompt.
  canInteractWithUser: false,
  sessionId: gs.generateGUID(),
  // contextMemory: CONTEXT_MEMORY,          // uncomment to pass prior history
  // structuredOutputRequest: STRUCTURED_OUTPUT, // uncomment for JSON output
});

if (result.status !== 'success') {
  gs.info('[ERROR] Launch failed: ' + result.status);
  var err = result.error || {};
  for (var k in err) {
    if (err.hasOwnProperty(k)) gs.info('[ERROR]   ' + k + ': ' + err[k]);
  }
  throw new Error('Agent launch failed');
}

var conversationId = result.data.conversationId;
var executionPlanId = result.data.executionPlanId;

var instanceUrl = (gs.getProperty('glide.servlet.uri') || 'http://localhost:8080').replace(/\/$/, '');

gs.info('[OK] Agent launched successfully');
gs.info('[OK] Conversation ID:   ' + conversationId);
gs.info('[OK] Execution Plan ID: ' + executionPlanId);
gs.info('[LINK] ' + instanceUrl + '/now/agent-studio/playground/params/execution-plan/' + executionPlanId);

// -----------------------------------------------------------------------------
// Step 3: Poll for completion (up to 3 minutes)
// -----------------------------------------------------------------------------
gs.info('[WAIT] Polling for completion (max 180s)...');

var maxWaitMs = 180000;
var startTime = new GlideDateTime().getNumericValue();
var lastLogMs = startTime;
var finalState = 'in_progress';

while (true) {
  var now = new GlideDateTime().getNumericValue();
  if (now - startTime > maxWaitMs) {
    gs.info('[TIMEOUT] Agent still running after 180s — check manually');
    break;
  }

  var checkGr = new GlideRecord('sn_aia_execution_plan');
  checkGr.get(executionPlanId);
  finalState = checkGr.getValue('state');

  if (finalState === 'completed' || finalState === 'terminated') {
    gs.info('[DONE] Execution plan state: ' + finalState);
    gs.info('[DONE] Execution time: ' + checkGr.getValue('execution_time_sec') + 's');
    break;
  }

  // gatherData means the agent is waiting for user input — won't complete
  // without canInteractWithUser: true. If this appears, something is wrong.
  if (finalState === 'gatherData') {
    gs.info('[WARN] Agent paused in gatherData — expected canInteractWithUser: false to prevent this');
    gs.info('[WARN] Check that the usecase and agent are configured for non-interactive execution');
    break;
  }

  // Throttle to one log line per 30s based on wall-clock time.
  // GlideSystem.sleep() is unreliable in background scripts — do not use
  // iteration count for throttling; it fires on every iteration instead.
  if (now - lastLogMs >= 30000) {
    var elapsed = Math.round((now - startTime) / 1000);
    gs.info('[WAIT] State: ' + finalState + ' — ' + elapsed + 's elapsed');
    lastLogMs = now;
  }
  GlideSystem.sleep(500);
}

// -----------------------------------------------------------------------------
// Step 4: Print execution task trace (orchestrator → sub-agents → communicator)
// sn_aia_message.conversation field does not exist on all sn_aia versions;
// sn_aia_execution_task.execution_plan is the reliable join we can query.
// -----------------------------------------------------------------------------
gs.info('[RESULTS] Execution task trace:');

var traceGr = new GlideRecord('sn_aia_execution_task');
traceGr.addQuery('execution_plan', executionPlanId);
traceGr.orderBy('run_order');
traceGr.query();
while (traceGr.next()) {
  var taskType = traceGr.getValue('type') || 'unknown';
  var taskMeta = traceGr.getValue('metadata') || '{}';
  var taskMsg = '';
  try {
    var tParsed = JSON.parse(taskMeta);
    taskMsg = tParsed.message || tParsed.task || tParsed.report || '';
  } catch (e) {
    taskMsg = taskMeta;
  }
  if (taskMsg) {
    gs.info('[' + taskType.toUpperCase() + '] ' + taskMsg.substring(0, 300));
  }
}

// -----------------------------------------------------------------------------
// Step 5: Print the communicator task final output
// The communicator task metadata.message is the verified reliable final summary.
// -----------------------------------------------------------------------------
gs.info('[RESULTS] Communicator task output:');

var taskGr = new GlideRecord('sn_aia_execution_task');
taskGr.addQuery('execution_plan', executionPlanId);
taskGr.addQuery('type', 'communicator');
taskGr.orderByDesc('run_order');
taskGr.setLimit(1);
taskGr.query();
if (taskGr.next()) {
  var meta = taskGr.getValue('metadata') || '{}';
  try {
    var metaParsed = JSON.parse(meta);
    gs.info('[FINAL] ' + (metaParsed.message || '(no message in metadata)'));
  } catch (e) {
    gs.info('[FINAL] (metadata not parseable): ' + meta.substring(0, 200));
  }
} else {
  gs.info('[FINAL] No communicator task found');
}

gs.info('[DONE] Test complete. Conversation: ' + conversationId);
gs.info('[LINK] ' + instanceUrl + '/now/agent-studio/playground/params/execution-plan/' + executionPlanId);
