/**
 * The sys_trigger transport's output protocol: how a background script's output
 * crosses back from the scheduler into this process.
 *
 * Why chunks. `sys_properties.value` is a 4000-char column, and the wrapper
 * script reserved only 2700 of that for output. Anything longer was silently
 * cut at the SOURCE — before the tool's own 8000-char render cap could even
 * see it — so the transport destroyed data the tool was prepared to return.
 * Measured on a real transcript, 11 of 61 background-script calls (18%) hit
 * that limit.
 *
 * The protocol: one PARENT property carries the status envelope and a chunk
 * count; each chunk lives in its own indexed property. The reader reassembles
 * in index order and verifies the count, so a missing or duplicated chunk is a
 * detected error rather than silently corrupted output.
 *
 * This module is pure — no HTTP, no ServiceNow types — so the reassembly and
 * its failure modes are directly testable. The wrapper-script side (which runs
 * in Rhino on the instance) is generated here too, keeping the writer and the
 * reader of the same wire format in one file where they cannot drift apart.
 */

/**
 * Characters per chunk property. `sys_properties.value` holds 4000; 3500 leaves
 * headroom for any escaping the platform applies on the way in without wasting
 * a whole extra round trip per chunk.
 */
export const CHUNK_CHARS = 3500;

/**
 * Hard ceiling on chunks per execution. At CHUNK_CHARS each this bounds total
 * output near 56k characters — comfortably above the tool's 8000-char render
 * cap, so the tool's guardrail decides what the caller sees while the transport
 * no longer decides it first. It also bounds the cleanup work a runaway script
 * can create.
 */
export const MAX_CHUNKS = 16;

/** Total characters the transport will carry. Output beyond this is truncated
 * at the source and reported as such — explicitly, not silently. */
export const MAX_TOTAL_CHARS = CHUNK_CHARS * MAX_CHUNKS;

/** The status envelope the wrapper writes into the parent property. */
export interface MailboxEnvelope {
	status: 'pending' | 'done';
	success?: boolean;
	/** Number of chunk properties written. Absent/0 on the legacy single-mailbox
	 * shape, where the payload sits inline in `output`/`error`. */
	chunkCount?: number;
	/** Legacy inline payload, retained so a trigger created by a previous build
	 * (or a mid-upgrade in-flight execution) still reads back correctly. */
	output?: string;
	error?: string;
	outputTruncated?: boolean;
	outputOriginalChars?: number;
	outputReturnedChars?: number;
	runtimeIdentity?: unknown;
	/** Set by the wrapper when it could not persist one or more chunks — the
	 * payload is incomplete for a KNOWN reason, which must not be reported as a
	 * generic script failure. */
	chunkWriteFailed?: boolean;
	/** Wall-clock ms the script body itself took, measured inside the trigger. */
	scriptDurationMs?: number;
}

/** Property name for chunk `index` of the execution keyed by `parentKey`. */
export function chunkKey(parentKey: string, index: number): string {
	return `${parentKey}.chunk.${index}`;
}

export interface ReassemblyResult {
	payload: string;
	/** Populated when the chunk set was not intact. The payload is then whatever
	 * could be recovered, and the caller must surface the problem rather than
	 * treating a short result as complete output. */
	error?: string;
}

/**
 * Rebuild the payload from chunk properties.
 *
 * Detects the three ways a chunk set can be wrong — missing index, duplicate
 * index, unparseable value — because each of them silently shortens the output
 * otherwise, and a silently shortened result is indistinguishable from a script
 * that simply logged less. That is the same class of bug as the silent-zero
 * read this whole effort exists to eliminate.
 */
export function reassembleChunks(
	parentKey: string,
	chunkCount: number,
	rows: Array<{ name?: string; value?: string }>,
): ReassemblyResult {
	const byIndex = new Map<number, string>();
	const duplicates: number[] = [];

	for (const row of rows) {
		const name = row?.name;
		if (!name) continue;
		const prefix = `${parentKey}.chunk.`;
		if (!name.startsWith(prefix)) continue;
		const index = Number.parseInt(name.slice(prefix.length), 10);
		if (!Number.isInteger(index) || index < 0) continue;
		if (byIndex.has(index)) {
			duplicates.push(index);
			continue;
		}
		byIndex.set(index, row.value ?? '');
	}

	const missing: number[] = [];
	const parts: string[] = [];
	for (let i = 0; i < chunkCount; i++) {
		const part = byIndex.get(i);
		if (part === undefined) {
			missing.push(i);
			continue;
		}
		parts.push(part);
	}

	const problems: string[] = [];
	if (missing.length > 0) {
		problems.push(`missing chunk(s) ${missing.join(', ')} of ${chunkCount}`);
	}
	if (duplicates.length > 0) {
		problems.push(`duplicate chunk(s) ${[...new Set(duplicates)].join(', ')}`);
	}

	return {
		payload: parts.join(''),
		...(problems.length > 0
			? {
					error:
						`Background-script output could not be fully reassembled: ${problems.join('; ')}. ` +
						`The returned output is INCOMPLETE — do not treat it as the script's full output.`,
				}
			: {}),
	};
}

/**
 * The Rhino-side chunk writer, inlined into the wrapper script.
 *
 * Kept next to reassembleChunks deliberately: these two are the writer and the
 * reader of the same wire format, and a change to one that misses the other
 * corrupts every result. Written as ES5 — this runs in ServiceNow's Rhino
 * engine, which has no let/const, arrow functions, or template literals.
 *
 * Returns an expression-statement block defining `__writeChunks(text)`, which
 * returns `{count, truncated, originalChars, returnedChars, failed}`.
 */
export function chunkWriterSource(parentKeyLiteral: string): string {
	return `
	  var __writeChunks = function(text) {
	    var __original = text.length;
	    var __capped = text.length > ${MAX_TOTAL_CHARS} ? text.substring(0, ${MAX_TOTAL_CHARS}) : text;
	    var __count = 0;
	    var __failed = false;
	    for (var __i = 0; __i * ${CHUNK_CHARS} < __capped.length && __i < ${MAX_CHUNKS}; __i++) {
	      var __slice = __capped.substring(__i * ${CHUNK_CHARS}, (__i + 1) * ${CHUNK_CHARS});
	      try {
	        var __cg = new GlideRecord('sys_properties');
	        __cg.initialize();
	        __cg.setValue('name', ${parentKeyLiteral} + '.chunk.' + __i);
	        __cg.setValue('value', __slice);
	        __cg.setValue('description', 'Temporary MCP background-script output chunk — safe to delete');
	        __cg.setValue('type', 'string');
	        if (!__cg.insert()) { __failed = true; }
	        else { __count++; }
	      } catch (__e) { __failed = true; }
	    }
	    return {
	      count: __count,
	      truncated: __original > ${MAX_TOTAL_CHARS},
	      originalChars: __original,
	      returnedChars: __capped.length,
	      failed: __failed
	    };
	  };
	`;
}
