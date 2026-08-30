# Trigger-Mode Setup (record/scheduled/email triggers)

> **The single biggest time sink in trigger work (~4 hours of debugging) was discovering that trigger mode requires a dedicated AI user — a dynamic user silently fails.** This doc captures the full contract so the next agent gets it right the first time.

Manual (copilot) invocation works with either a dynamic user or an AI user. **Trigger mode does not.** When an agent is dispatched by a trigger, it runs in **async flow context**, and `AIAAccessControlManager` cannot resolve a session identity from a dynamic user there. The run terminates with:

```
state_reason = "security_violation"
```

…with no other obvious error. The Fluent source looks fine (e.g. `runAsUser: '<owen-sys-id>'`), the deploy succeeds, and the agent just dies on every trigger. **A dedicated AI user is mandatory for any triggered agent — treat "create the AI user" as Step 1 of trigger setup, not a footnote.**

---

## The five coupled records across four tables

Trigger mode is not one record — it is **five coupled records across four tables**, and it **fails silently if any one is missing**:

| # | Table | Record | Key fields / notes |
|---|---|---|---|
| 1 | `sn_aia_trigger_configuration` | The trigger config | `active=true`, `run_as_user=<AI user sys_id>`, `trigger_flow_definition_type='record_create'` (or the matching type), plus the trigger criteria |
| 2 | `sn_aia_trigger_agent_usecase_m2m` | Trigger → use case link | `active=true`, links the trigger config to the use case |
| 3 | `sys_agent_access_role_configuration` | Use-case access roles | use case + `role_list` |
| 4 | `sys_hub_flow` | Auto-generated backing flow | Created by an **async business rule** — but **only fires on INSERT of the trigger config, never on UPDATE**. If you edit a trigger config that never had its flow generated, the flow will never appear. |
| 5 | `sys_security_acl` | ACL named after the use case's `internal_name` | **Cannot be written via the SDK.** Requires `security_admin` interactive elevation + a Background Script (see below). |

**Silent-failure implication:** there is no single "deploy succeeded" signal that confirms all five exist. After deploying, verify each one explicitly.

### Gotcha 1 — `sys_hub_flow` is INSERT-only

The async BR that generates the backing flow fires on **insert** of `sn_aia_trigger_configuration`, not on update. If a trigger config exists but its flow doesn't, editing the config won't regenerate it — delete and re-insert the trigger config (or trigger the BR another way).

### Gotcha 2 — the ACL cannot be SDK-written

`sys_security_acl` records named after the use case's `internal_name` are blocked from SDK/Fluent writes. They require `security_admin` elevation and must be created interactively via a Background Script:

> **Running it:** If ServiceNow MCP is authenticated **and** the session has `security_admin` elevation in effect, run the script below automatically via `sn_execute_background_script` (param: `script`) and read the `gs.info` output for the created/existing ACL sys_id. If MCP is not authenticated (or elevation is not in effect), run it manually in **Scripts > Background** after elevating (gear menu → Elevate Roles → `security_admin`).
>
> **Caveat:** `sn_execute_background_script` runs as the integration/admin user and does **not** itself perform the `security_admin` role elevation. If the ACL insert returns a permission error, fall back to the manual elevated path above.

```js
// Scripts > Background — elevate to security_admin first (gear menu → Elevate Roles → security_admin)
(function () {
    var usecaseInternalName = '<usecase internal_name>'; // e.g. sn_aia_usecase_<...>
    var acl = new GlideRecord('sys_security_acl');
    acl.addQuery('name', usecaseInternalName);
    acl.query();
    if (acl.next()) {
        gs.info('ACL already exists: ' + acl.getUniqueValue());
        return;
    }
    var rec = new GlideRecord('sys_security_acl');
    rec.initialize();
    rec.setValue('name', usecaseInternalName);
    rec.setValue('operation', 'execute'); // verify the correct operation for your release
    rec.setValue('active', true);
    gs.info('Created ACL: ' + rec.insert());
})();
```

> Verify column names (`operation`, etc.) against `sys_dictionary` for your release before running; do not rely on remembered schema.

---

## Ship the AI user as a Fluent template

So every new triggered agent gets a clean run-as identity by default, scaffold the AI user as a Fluent `sys_user` record. Register its key in `keys.ts`.

```ts
// src/fluent/agent/ai-agent-<agent>/<agent>-ai-user.now.ts
import { Record } from '@servicenow/sdk/core'

// The service-account user the trigger runs as.
export const aiUser = Record({
    $id: Now.ID['<agent>-ai-user'],
    table: 'sys_user',
    data: {
        user_name: '<agent>.ai.agent',
        first_name: '<Agent>',
        last_name: 'AI Agent',
        active: 'true',
        // web_service_access_only / internal_integration_user as appropriate for your policy
        sys_domain: 'global',
    },
})
```

Then set `run_as_user` on the trigger configuration (record 1 above) to `aiUser` — never to a dynamic user, and never to a column-derived user for trigger mode.

---

## Post-deploy verification (run after every trigger deploy)

Because failures are silent, confirm all five records before declaring the trigger working:

> **Running it:** If MCP is authenticated, run this via `sn_execute_background_script` and parse the printed JSON; otherwise paste it into **Scripts > Background**. Any field reading `MISSING` or `0` is a silent failure.

```js
// Scripts > Background (agent scope)
(function () {
    var usecaseId = '<usecase sys_id>';
    var out = {};

    var tc = new GlideRecord('sn_aia_trigger_configuration');
    tc.addQuery('run_as_user.user_name', '<agent>.ai.agent'); // or query by your trigger name
    tc.query();
    out.trigger_config = tc.next()
        ? { id: tc.getUniqueValue(), active: tc.getValue('active'), run_as_user: tc.getValue('run_as_user') }
        : 'MISSING';

    var m2m = new GlideRecord('sn_aia_trigger_agent_usecase_m2m');
    m2m.query();
    out.trigger_m2m_count = m2m.getRowCount();

    var ar = new GlideRecord('sys_agent_access_role_configuration');
    ar.query();
    out.access_role_count = ar.getRowCount();

    var flow = new GlideRecord('sys_hub_flow');
    flow.query();
    out.hub_flow_count = flow.getRowCount();

    var acl = new GlideRecord('sys_security_acl');
    acl.query();
    out.acl_count = acl.getRowCount();

    gs.info('=== TRIGGER VERIFY === ' + JSON.stringify(out, null, 2));
})();
```

Anything reading `MISSING` or `0` is a silent failure — fix it before testing the trigger.

---

## Checklist

1. [ ] **AI user created first** (Fluent `sys_user`) — not a dynamic user
2. [ ] `sn_aia_trigger_configuration` with `active=true`, `run_as_user=<AI user>`, correct `trigger_flow_definition_type`
3. [ ] `sn_aia_trigger_agent_usecase_m2m` active, linking trigger → use case
4. [ ] `sys_agent_access_role_configuration` with use case + `role_list`
5. [ ] `sys_hub_flow` auto-generated (confirm it exists — it only generates on INSERT of the trigger config)
6. [ ] `sys_security_acl` created via `security_admin` Background Script (cannot be SDK-written)
7. [ ] Triggers deploy **inactive** — activate manually after testing
8. [ ] Run the post-deploy verification script — every record present, none `MISSING`/`0`
