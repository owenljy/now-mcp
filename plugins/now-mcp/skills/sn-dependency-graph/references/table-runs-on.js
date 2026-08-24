/**
 * Template: table-runs-on
 * Purpose: What runs on a given table — extends/extended-by hierarchy, active
 *          business rules, active client scripts, active UI policies. A
 *          compact, server-side-reduced summary (no script/condition body
 *          text), computed in one round trip instead of several.
 * Scope:   READ-ONLY. Performs zero writes.
 * Run via: sn_execute_background_script with resultMode: 'json'
 *          (no allowWrites needed).
 * Not covered: ACLs (use sn_get_security_info — it already covers this in
 *          more depth: role groups, effective access, data policies) and
 *          flow triggers (the trigger-config table/field names need to be
 *          verified against the target instance's schema before scripting
 *          that section — guessing them risks a query that silently returns
 *          nothing while looking like a real answer).
 *
 * Before running: replace {{TARGET}} below with the table name.
 */
(function () {
	var TARGET = '{{TARGET}}';
	var out = { success: true, table: TARGET, hierarchy: [], businessRules: [], clientScripts: [], uiPolicies: [] };

	var probe = new GlideRecord(TARGET);
	if (!probe.isValid()) {
		log(JSON.stringify({ success: false, error: 'table not found or not readable: ' + TARGET }));
		return;
	}

	// Extends chain, same walk used by sn_diagnose_mutation.
	var cursor = TARGET, seen = {};
	seen[TARGET] = true;
	out.hierarchy.push(TARGET);
	try {
		while (cursor) {
			var dbo = new GlideRecord('sys_db_object');
			if (!dbo.get('name', cursor)) break;
			var parent = String(dbo.getValue('super_class') || '');
			if (!parent) break;
			var parentObj = new GlideRecord('sys_db_object');
			if (!parentObj.get(parent)) break;
			cursor = String(parentObj.getValue('name') || '');
			if (!cursor || seen[cursor]) break;
			seen[cursor] = true;
			out.hierarchy.push(cursor);
		}
	} catch (hierarchyError) {
		out.hierarchyError = String(hierarchyError);
	}

	// Active business rules — name/when/order/action flags only, never the script body.
	try {
		var br = new GlideRecord('sys_script');
		br.addQuery('collection', TARGET);
		br.addQuery('active', true);
		br.setLimit(100);
		br.query();
		while (br.next()) {
			out.businessRules.push({
				sys_id: String(br.getUniqueValue()),
				name: String(br.getValue('name') || ''),
				when: String(br.getValue('when') || ''),
				order: String(br.getValue('order') || ''),
				insert: br.getValue('action_insert') === 'true',
				update: br.getValue('action_update') === 'true',
				delete: br.getValue('action_delete') === 'true',
				query: br.getValue('action_query') === 'true',
			});
		}
		if (out.businessRules.length === 100) out.businessRulesCapped = true;
	} catch (brError) {
		out.businessRulesError = String(brError);
	}

	// Active client scripts — name/type only.
	try {
		var cs = new GlideRecord('sys_script_client');
		cs.addQuery('table', TARGET);
		cs.addQuery('active', true);
		cs.setLimit(100);
		cs.query();
		while (cs.next()) {
			out.clientScripts.push({
				sys_id: String(cs.getUniqueValue()),
				name: String(cs.getValue('name') || ''),
				type: String(cs.getValue('type') || ''),
			});
		}
		if (out.clientScripts.length === 100) out.clientScriptsCapped = true;
	} catch (csError) {
		out.clientScriptsError = String(csError);
	}

	// Active UI policies — short_description only.
	try {
		var up = new GlideRecord('sys_ui_policy');
		up.addQuery('table', TARGET);
		up.addQuery('active', true);
		up.setLimit(100);
		up.query();
		while (up.next()) {
			out.uiPolicies.push({
				sys_id: String(up.getUniqueValue()),
				short_description: String(up.getValue('short_description') || ''),
			});
		}
		if (out.uiPolicies.length === 100) out.uiPoliciesCapped = true;
	} catch (upError) {
		out.uiPoliciesError = String(upError);
	}

	out.generatedAt = new GlideDateTime().getValue() + ' UTC';
	log(JSON.stringify(out));
})();
