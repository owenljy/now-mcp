const HIGH_VOLUME_TABLES = new Set(['syslog', 'sys_audit', 'sys_history_line', 'sys_email']);

export interface QueryRiskAssessment {
	risky: boolean;
	reasons: string[];
	suggestion?: string;
}

/** Conservative preflight for encoded queries that are predictably scan-heavy. */
export function assessQueryRisk(tableName: string, query?: string): QueryRiskAssessment {
	if (!query || !HIGH_VOLUME_TABLES.has(tableName.toLowerCase()))
		return { risky: false, reasons: [] };
	const hasTextSearch = /(?:^|\^)(?:OR|NQ)?[a-zA-Z0-9_.]+(?:LIKE|CONTAINS)/i.test(query);
	const hasBranching = /\^(?:OR|NQ)/i.test(query);
	const hasBoundedTime =
		/(?:^|\^)(?:OR|NQ)?sys_(?:created|updated)_on(?:>=|>|BETWEEN|ON|RELATIVE)/i.test(query);
	if (!hasTextSearch || hasBoundedTime) return { risky: false, reasons: [] };

	const reasons = [
		`${tableName} is a high-volume table and the query searches text without a bounded sys_created_on/sys_updated_on predicate.`,
		...(hasBranching ? ['Top-level ^OR/^NQ branches can multiply scan cost.'] : []),
		'limit constrains returned rows, not database scan cost.',
	];
	const since = new Date(Date.now() - 15 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
	return {
		risky: true,
		reasons,
		suggestion:
			`Add a narrow leading time bound, for example sys_created_on>=${since}^${query}. ` +
			(hasBranching ? 'Prefer splitting each OR branch into a separate bounded call.' : ''),
	};
}
