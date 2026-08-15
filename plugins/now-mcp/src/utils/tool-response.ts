/**
 * Serialization helper for MCP tool-result text.
 *
 * Tool results persist in the model's context for the whole session, so their
 * token cost is paid on every subsequent turn. This helper keeps that cost low:
 *   - Compact JSON (no pretty-print indentation, which is pure token overhead
 *     for an LLM consumer).
 *   - A hard character cap so a runaway query or background-script dump can't
 *     balloon the context; when tripped, the result is truncated with a hint to
 *     narrow the request.
 */

const MAX_TOOL_TEXT = 16000;

export function toolText(value: unknown): string {
	const s = JSON.stringify(value);
	return s.length <= MAX_TOOL_TEXT
		? s
		: s.slice(0, MAX_TOOL_TEXT) +
				`\n…[truncated ${s.length - MAX_TOOL_TEXT} chars — narrow fields/limit or use sn_aggregate_records]`;
}

/** Shape of an MCP tool success result carrying structured output. */
interface StructuredToolResult {
	content: { type: 'text'; text: string }[];
	structuredContent: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

/**
 * Build a success result whose full data lives ONLY in `structuredContent`,
 * while the text block carries a short human summary.
 *
 * Why: MCP delivers both `content.text` and `structuredContent` to the model, so
 * serializing the whole payload into both (the old `toolText(response)` +
 * `structuredContent: response` pattern) paid ~2× the tokens per call. The model
 * consumes the machine-readable data from `structuredContent` (verified: a
 * structuredContent-only field is visible to the caller), so the text only needs
 * to be a glanceable recap — counts + identity — not the data itself.
 *
 * `summary` should be a single short line (e.g. "42 rows on incident").
 * `extraText` appends further text blocks (e.g. a truncation note) after it.
 */
export function toolResult(
	structuredContent: Record<string, unknown>,
	summary: string,
	opts?: { meta?: Record<string, unknown>; extraText?: string[] },
): StructuredToolResult {
	const content: { type: 'text'; text: string }[] = [{ type: 'text', text: summary }];
	for (const t of opts?.extraText ?? []) {
		content.push({ type: 'text', text: t });
	}
	return opts?.meta
		? { content, structuredContent, _meta: opts.meta }
		: { content, structuredContent };
}

/**
 * Result builder for the write tools (create / update / delete), which all
 * return per-record outcomes for one record or fifty.
 *
 * The only addition over `toolResult` is the error signal: a call where NOTHING
 * succeeded is `isError`, because the caller asked for writes and got none — the
 * same signal a single-record failure has always produced. A partial success is
 * not an error; its counts and `results[]` describe exactly what landed, and
 * flagging it would misreport the records that did persist.
 */
export function writeResult(
	structuredContent: Record<string, unknown> & {
		summary: { total: number; successCount: number; failureCount: number };
	},
	summary: string,
	opts?: { extraText?: string[] },
): StructuredToolResult & { isError?: true } {
	const base = toolResult(structuredContent, summary, opts);
	return structuredContent.summary.successCount === 0 ? { ...base, isError: true } : base;
}
