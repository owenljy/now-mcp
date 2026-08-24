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
 * NOTHING LOAD-BEARING MAY LIVE IN THE TEXT BLOCK. Measured against Claude
 * Code: when a result carries `structuredContent`, the client delivers that
 * alone and the text blocks never reach the model — the same call with no
 * `structuredContent` (e.g. the CI write-routing refusal) does deliver its
 * text. So a truncation note or a recovery hint emitted as a text block is
 * simply lost, and silently: a truncated result reads as a complete one.
 *
 * That is why this takes no `extraText`. Every warning, hint, and truncation
 * note belongs on a key of `structuredContent` (`hints`, `warnings`,
 * `truncated`, …). `summary` is a glanceable recap for a human reading the
 * transcript — counts and identity, never information found nowhere else.
 */
export function toolResult(
	structuredContent: Record<string, unknown>,
	summary: string,
	opts?: { meta?: Record<string, unknown> },
): StructuredToolResult {
	const content: { type: 'text'; text: string }[] = [{ type: 'text', text: summary }];
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
): StructuredToolResult & { isError?: true } {
	const base = toolResult(structuredContent, summary);
	return structuredContent.summary.successCount === 0 ? { ...base, isError: true } : base;
}
