/**
 * False-positive corpus for computeCostHint (test/result-economics.test.js).
 *
 * WELL_FORMED_CALLS: zero tolerance — every one of these must NOT fire a
 * hint. Drawn from real usage: fields-scoped + limit-bounded query blocks
 * (matching the pattern used throughout the two aia-toolkit skills),
 * get-runtime-events-tool.ts's fixed-field reads, an id-harvest, an expand
 * call, a zero-result call, a limit:5 call.
 *
 * WASTEFUL_CALLS: calls a real session would want steered away from.
 */

function columnarOf(records, fields) {
	const columns = fields ?? (records.length > 0 ? Object.keys(records[0]) : []);
	const rows = records.map((r) => columns.map((c) => (c in r ? r[c] : null)));
	return { columns, rows };
}

function incident(i) {
	return {
		sys_id: i.toString(16).padStart(32, '0'),
		number: `INC00${1000 + i}`,
		short_description: `Net down site ${i}`,
		priority: String((i % 4) + 1),
		state: String((i % 6) + 1),
	};
}

export const WELL_FORMED_CALLS = [
	// fields-scoped, limit-bounded — the everyday shape.
	(() => {
		const records = Array.from({ length: 10 }, (_, i) => incident(i));
		const { columns, rows } = columnarOf(records, ['sys_id', 'number', 'priority']);
		return {
			label: 'fields-scoped incident read, limit 10',
			input: {
				table: 'incident',
				fields: ['sys_id', 'number', 'priority'],
				query: 'active=true',
				limit: 10,
				fetchedCount: 10,
				totalMatching: 42,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// limit:1 sys_id read.
	(() => {
		const { columns, rows } = columnarOf([{ sys_id: 'a'.repeat(32) }], ['sys_id']);
		return {
			label: 'limit:1 sys_id read',
			input: {
				table: 'incident',
				fields: ['sys_id'],
				query: 'number=INC0010001',
				limit: 1,
				fetchedCount: 1,
				totalMatching: 1,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// fields:["sys_id"] id-harvest for chaining — many rows, one column, but
	// exempt via fields.length<=2 (R2).
	(() => {
		const records = Array.from({ length: 50 }, (_, i) => ({ sys_id: i.toString(16).padStart(32, '0') }));
		const { columns, rows } = columnarOf(records, ['sys_id']);
		return {
			label: 'sys_id id-harvest for chaining',
			input: {
				table: 'incident',
				fields: ['sys_id'],
				query: 'active=true',
				limit: 50,
				fetchedCount: 50,
				totalMatching: 50,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// expand call — caller explicitly wanted joined rows.
	(() => {
		const records = Array.from({ length: 20 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `INC00${1000 + i}`,
			'caller_id.name': `User ${i}`,
		}));
		const { columns, rows } = columnarOf(records, ['sys_id', 'number', 'caller_id.name']);
		return {
			label: 'expand call',
			input: {
				table: 'incident',
				fields: ['sys_id', 'number'],
				query: 'active=true',
				limit: 20,
				fetchedCount: 20,
				totalMatching: 20,
				truncated: false,
				expandUsed: true,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// zero-result call — zeroResultHints owns this path.
	{
		label: 'zero-result call',
		input: {
			table: 'incident',
			fields: ['sys_id'],
			query: 'number=INC_DOES_NOT_EXIST',
			limit: 100,
			fetchedCount: 0,
			totalMatching: 0,
			truncated: false,
			expandUsed: false,
			queryPolicy: 'safe',
			columns: [],
			rows: [],
		},
	},
	// limit:5 call — always exempt regardless of shape.
	(() => {
		const records = Array.from({ length: 5 }, (_, i) => incident(i));
		const { columns, rows } = columnarOf(records);
		return {
			label: 'limit:5 call, fields omitted',
			input: {
				table: 'incident',
				query: 'active=true',
				limit: 5,
				fetchedCount: 5,
				totalMatching: 200,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// get-runtime-events-tool.ts's fixed 5-field syslog read.
	(() => {
		const records = Array.from({ length: 20 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			sys_created_on: '2026-08-01 12:00:00',
			level: '0',
			source: 'my.app',
			message: `log line ${i} with some free-text detail that varies per row`,
		}));
		const fields = ['sys_id', 'sys_created_on', 'level', 'source', 'message'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'runtime-events fixed-field syslog read',
			input: {
				table: 'syslog',
				fields,
				query: 'sys_created_on>=2026-08-01 00:00:00',
				limit: 20,
				fetchedCount: 20,
				totalMatching: null,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// allow_expensive — caller already accepted the cost.
	(() => {
		const records = Array.from({ length: 100 }, (_, i) => incident(i));
		const { columns, rows } = columnarOf(records);
		return {
			label: 'allow_expensive, fields omitted',
			input: {
				table: 'incident',
				query: 'messageLIKEx',
				limit: 100,
				fetchedCount: 100,
				totalMatching: null,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'allow_expensive',
				columns,
				rows,
			},
		};
	})(),
	// change_request, queried, scoped fields, known total — an everyday read.
	(() => {
		const records = Array.from({ length: 15 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `CHG00${1000 + i}`,
			state: String((i % 5) + 1),
			short_description: `Change window ${i} covering various systems`,
		}));
		const fields = ['sys_id', 'number', 'state', 'short_description'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'change_request queried read, known total',
			input: {
				table: 'change_request',
				fields,
				query: 'active=true',
				limit: 15,
				fetchedCount: 15,
				totalMatching: 15,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// problem read with a free-text field present — not a categorical/identifier-only page.
	(() => {
		const records = Array.from({ length: 30 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `PRB00${1000 + i}`,
			description: `Root cause analysis notes for problem ${i}, varies substantially`,
		}));
		const fields = ['sys_id', 'number', 'description'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'problem read with free-text description column',
			input: {
				table: 'problem',
				fields,
				query: 'active=true',
				limit: 30,
				fetchedCount: 30,
				totalMatching: 30,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// cmdb_ci read with a unique asset_tag column — high-cardinality, not categorical.
	(() => {
		const records = Array.from({ length: 20 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			asset_tag: `AT${100000 + i}`,
			install_status: String((i % 3) + 1),
		}));
		const fields = ['sys_id', 'asset_tag', 'install_status'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'cmdb_ci read with unique asset_tag column',
			input: {
				table: 'cmdb_ci',
				fields,
				query: 'install_status=1',
				limit: 20,
				fetchedCount: 20,
				totalMatching: 20,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// task read, small limit, known total — a routine bounded read.
	(() => {
		const records = Array.from({ length: 12 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `TASK00${1000 + i}`,
			short_description: `Task detail ${i} with varying free text`,
			state: String((i % 4) + 1),
			priority: String((i % 4) + 1),
		}));
		const fields = ['sys_id', 'number', 'short_description', 'state', 'priority'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'task read, small limit, known total',
			input: {
				table: 'task',
				fields,
				query: 'active=true',
				limit: 12,
				fetchedCount: 12,
				totalMatching: 12,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// fields omitted, but small enough that neither the row-count nor
	// column-count thresholds (rule E's 15, rule C's 20 columns) trip.
	(() => {
		const records = Array.from({ length: 8 }, (_, i) => incident(i));
		const { columns, rows } = columnarOf(records);
		return {
			label: 'fields omitted, small fetch, query present',
			input: {
				table: 'incident',
				query: 'assigned_to=' + 'a'.repeat(32),
				limit: 20,
				fetchedCount: 8,
				totalMatching: 8,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// sys_user lookup, two fields — exempt via the narrow-selection rule, not row count.
	(() => {
		const records = Array.from({ length: 5 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			email: `user${i}@example.com`,
		}));
		const fields = ['sys_id', 'email'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'sys_user lookup, two fields',
			input: {
				table: 'sys_user',
				fields,
				query: 'active=true',
				limit: 5,
				fetchedCount: 5,
				totalMatching: 5,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// A wide-but-known-total page — totalMatching present means D can't fire,
	// and the mixed free-text/categorical columns mean A can't either.
	(() => {
		const records = Array.from({ length: 40 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `INC00${1000 + i}`,
			short_description: `Detail ${i} varies per row quite a bit`,
			priority: String((i % 4) + 1),
		}));
		const fields = ['sys_id', 'number', 'short_description', 'priority'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'wide page with known total and a free-text column',
			input: {
				table: 'incident',
				fields,
				query: 'priority<=2',
				limit: 40,
				fetchedCount: 40,
				totalMatching: 40,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
];

export const WASTEFUL_CALLS = [
	// The triggering 67x7 case: mixed categorical + identifier columns, no free text.
	(() => {
		const records = Array.from({ length: 67 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `INC00${1000 + i}`,
			priority: String((i % 4) + 1),
			state: String((i % 6) + 1),
			assignment_group: i % 3 === 0 ? 'Network' : i % 3 === 1 ? 'Service Desk' : 'App Support',
			category: i % 2 === 0 ? 'hardware' : 'software',
			active: i % 2 === 0,
		}));
		const fields = ['sys_id', 'number', 'priority', 'state', 'assignment_group', 'category', 'active'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'triggering 67x7 case',
			input: {
				table: 'ais_ingest_embedding_stats',
				fields,
				limit: 100,
				fetchedCount: 67,
				totalMatching: 67,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// fields omitted on incident — wide table, everything comes back.
	(() => {
		const records = Array.from({ length: 25 }, (_, i) => ({
			...incident(i),
			category: i % 2 === 0 ? 'hardware' : 'software',
			assignment_group: i % 3 === 0 ? 'Network' : 'Service Desk',
			active: i % 2 === 0,
			impact: String((i % 3) + 1),
		}));
		const { columns, rows } = columnarOf(records);
		return {
			label: 'fields omitted on incident',
			input: {
				table: 'incident',
				limit: 100,
				fetchedCount: 25,
				totalMatching: 500,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// limit:1000 with 12 fields, no query — unfiltered whole-table page.
	(() => {
		const records = Array.from({ length: 200 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `INC00${1000 + i}`,
			short_description: `Free text detail number ${i} varies a lot per row here`,
			priority: String((i % 4) + 1),
			state: String((i % 6) + 1),
			assignment_group: i % 3 === 0 ? 'Network' : 'Service Desk',
			category: i % 2 === 0 ? 'hardware' : 'software',
			impact: String((i % 3) + 1),
			urgency: String((i % 3) + 1),
			active: i % 2 === 0,
			sys_updated_on: '2026-08-01 12:00:00',
			caller_id: i.toString(16).padStart(32, 'a'),
		}));
		const fields = Object.keys(records[0]);
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'limit:1000, 12 fields, no query',
			input: {
				table: 'incident',
				fields,
				limit: 1000,
				fetchedCount: 200,
				totalMatching: null,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// A truncated response — full page, no totalMatching, wide limit.
	(() => {
		const records = Array.from({ length: 1000 }, (_, i) => incident(i));
		const fields = ['sys_id', 'number', 'priority', 'state'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'truncated response',
			input: {
				table: 'incident',
				fields,
				limit: 1000,
				fetchedCount: 1000,
				totalMatching: null,
				truncated: true,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// fields:["sys_id"] at limit:1000 — a count in disguise.
	(() => {
		const records = Array.from({ length: 1000 }, (_, i) => ({ sys_id: i.toString(16).padStart(32, '0') }));
		const { columns, rows } = columnarOf(records, ['sys_id']);
		return {
			label: 'fields:["sys_id"] at limit:1000',
			input: {
				table: 'incident',
				fields: ['sys_id'],
				limit: 1000,
				fetchedCount: 1000,
				totalMatching: null,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
	// A queried, full page with no totalMatching reported at a wide limit — the
	// blind-pagination shape rule D targets specifically (distinct from rule E,
	// which only fires when there is no query at all).
	(() => {
		const records = Array.from({ length: 50 }, (_, i) => ({
			sys_id: i.toString(16).padStart(32, '0'),
			number: `INC00${1000 + i}`,
			short_description: `Free text detail ${i} varies per row`,
		}));
		const fields = ['sys_id', 'number', 'short_description'];
		const { columns, rows } = columnarOf(records, fields);
		return {
			label: 'queried full page, no totalMatching, limit 50',
			input: {
				table: 'incident',
				fields,
				query: 'active=true',
				limit: 50,
				fetchedCount: 50,
				totalMatching: null,
				truncated: false,
				expandUsed: false,
				queryPolicy: 'safe',
				columns,
				rows,
			},
		};
	})(),
];
