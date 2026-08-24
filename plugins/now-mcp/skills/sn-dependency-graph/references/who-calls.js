/**
 * Template: who-calls
 * Purpose: Who references a given target (typically a script include's class
 *          name, but works for any identifier) — scans script bodies across
 *          the tables most likely to call it and returns only
 *          {table, sys_id, name} per hit, never the matched script text.
 * Scope:   READ-ONLY. Performs zero writes.
 * Run via: sn_execute_background_script with resultMode: 'json'
 *          (no allowWrites needed).
 * Not exhaustive: covers script includes, business rules, client scripts,
 *          scripted REST resources, UI actions, and scheduled jobs. Flow
 *          script steps, inbound email actions, and UI macros are not
 *          scanned.
 *
 * Before running: replace {{TARGET}} below with the name to search for
 * (e.g. a script include's class name).
 */
(function () {
	var TARGET = '{{TARGET}}';
	var SOURCES = [
		{ table: 'sys_script_include', field: 'script', nameField: 'name' },
		{ table: 'sys_script', field: 'script', nameField: 'name' },
		{ table: 'sys_script_client', field: 'script', nameField: 'name' },
		{ table: 'sys_ws_operation', field: 'operation_script', nameField: 'name' },
		{ table: 'sys_ui_action', field: 'script', nameField: 'name' },
		{ table: 'sysauto_script', field: 'script', nameField: 'name' },
	];

	var out = { success: true, target: TARGET, matches: {}, totalMatches: 0 };

	for (var i = 0; i < SOURCES.length; i++) {
		var src = SOURCES[i];
		var hits = [];
		try {
			var gr = new GlideRecord(src.table);
			if (!gr.isValid()) {
				out.matches[src.table] = { error: 'table not found or not readable' };
				continue;
			}
			gr.addQuery(src.field, 'LIKE', TARGET);
			gr.setLimit(50);
			gr.query();
			while (gr.next()) {
				hits.push({
					sys_id: String(gr.getUniqueValue()),
					name: String(gr.getValue(src.nameField) || ''),
				});
			}
			out.matches[src.table] = { hits: hits, capped: hits.length === 50 };
			out.totalMatches += hits.length;
		} catch (scanError) {
			out.matches[src.table] = { error: String(scanError) };
		}
	}

	out.generatedAt = new GlideDateTime().getValue() + ' UTC';
	log(JSON.stringify(out));
})();
