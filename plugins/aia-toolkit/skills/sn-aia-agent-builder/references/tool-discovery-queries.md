# Tool-discovery queries — reuse before you build

Run when interviewing the user about capabilities (SKILL.md Step 1, Q2) to find
existing instance resources before proposing any new tool. Resolve the
`read_records` capability (see
[../../../references/mcp-capability-resolution.md](../../../references/mcp-capability-resolution.md))
and run these queries **in parallel** for each capability keyword, adapting the
param names below to whichever tool resolves. If no matching read tool is
connected, fall back to the background script in
[tool-discovery-bg-script.js](tool-discovery-bg-script.js) and ask the user to
paste the output. If neither is available, skip discovery and note the tool set is
unverified.

| Query | Table | Encoded query | Fields |
|---|---|---|---|
| Existing AIA tools | `sn_aia_tool` | `descriptionLIKE<kw>^ORnameLIKE<kw>` | name, type, target_document_table, sys_scope |
| Subflows | `sys_hub_flow` | `descriptionLIKE<kw>^ORnameLIKE<kw>^active=true` | name, sys_id, sys_scope |
| Flow actions | `sys_hub_action_type_definition` | `descriptionLIKE<kw>^ORnameLIKE<kw>^active=true` | name, sys_id, sys_scope |
| Now Assist skills | `sn_nowassist_skill_config` | `nameLIKE<kw>^ORdescriptionLIKE<kw>` | name, sys_id, sys_scope |
| Catalog items | `sc_cat_item` | `(nameLIKE<kw>^ORshort_descriptionLIKE<kw>)^active=true` | name, sys_id, sys_scope |
| VA topics | `sys_cs_topic` | `(nameLIKE<kw>^ORdescriptionLIKE<kw>)^active=true` | name, type, sys_id, sys_scope |
| Existing agents | `sn_aia_agent` | `descriptionLIKE<kw>^ORnameLIKE<kw>` | name, sys_id, sys_scope |
| Script Includes | `sys_script_include` | `nameLIKE<kw>^ORdescriptionLIKE<kw>^active=true` | name, api_name, access, sys_scope |

Map results to builder tool types: `sys_hub_flow` → `subflow` (`subflowId`),
`sys_hub_action_type_definition` → `action` (`flowActionId`),
`sn_nowassist_skill_config` → `capability` (`capabilityId`),
`sc_cat_item` → `catalog` (`catalogItemId`),
`sys_cs_topic` type=TOPIC → `topic` / TOPIC_BLOCK → `topic_block` (`virtualAgentId`).
Script Includes surface only for the script-tool path — check `access=public`
for cross-scope use. If an existing agent covers the use case, suggest extending
it (Q0 "editing").
