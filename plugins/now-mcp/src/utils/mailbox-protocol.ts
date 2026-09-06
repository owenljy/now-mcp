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

/** ES5 on purpose: the same function is embedded in the instance writer.
 * FNV-1a over UTF-16 code units detects accidental wire corruption, not tampering. */
export function payloadChecksum(text: string): string {
	var hash = 2166136261;
	var i = 0;
	for (i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return '00000000'.concat((hash >>> 0).toString(16)).slice(-8);
}

/** The status envelope the wrapper writes into the parent property. */
export interface MailboxEnvelope {
	status: 'pending' | 'running' | 'cancelled' | 'done';
	success?: boolean;
	/** Number of chunk properties written. Absent/0 on the legacy single-mailbox
	 * shape, where the payload sits inline in `output`/`error`. */
	chunkCount?: number;
	protocolVersion?: 2;
	payloadChecksum?: string;
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
	/** Time spent persisting output chunks before publishing the done envelope. */
	outputPersistenceDurationMs?: number;
}

export interface MailboxEnvelopeValidation {
	valid: boolean;
	envelope?: MailboxEnvelope;
	error?: string;
}

/**
 * Validate the instance-controlled mailbox value before using it for loop bounds
 * or exposing it through a typed response. A malformed/compromised property must
 * not be able to turn `chunkCount` into an unbounded CPU loop in this process.
 */
export function validateMailboxEnvelope(value: unknown): MailboxEnvelopeValidation {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return { valid: false, error: 'mailbox value is not an object' };
	}
	const candidate = value as Record<string, unknown>;
	if (candidate.protocolVersion !== undefined && candidate.protocolVersion !== 2) {
		return { valid: false, error: 'unsupported mailbox protocol version' };
	}
	if (
		candidate.status === 'done' &&
		candidate.protocolVersion === 2 &&
		(typeof candidate.payloadChecksum !== 'string' ||
			!/^[a-f0-9]{8}$/.test(candidate.payloadChecksum) ||
			candidate.outputReturnedChars === undefined ||
			candidate.chunkCount === undefined)
	) {
		return { valid: false, error: 'protocol v2 requires checksum, length and chunkCount' };
	}
	if (!['pending', 'running', 'cancelled', 'done'].includes(String(candidate.status))) {
		return { valid: false, error: 'mailbox status is invalid' };
	}
	if (candidate.status === 'done' && typeof candidate.success !== 'boolean') {
		return { valid: false, error: 'completed mailbox has no boolean success field' };
	}
	if (
		candidate.chunkCount !== undefined &&
		(!Number.isInteger(candidate.chunkCount) ||
			(candidate.chunkCount as number) < 0 ||
			(candidate.chunkCount as number) > MAX_CHUNKS)
	) {
		return { valid: false, error: `chunkCount must be an integer from 0 to ${MAX_CHUNKS}` };
	}
	for (const field of ['scriptDurationMs', 'outputPersistenceDurationMs'] as const) {
		const metric = candidate[field];
		if (
			metric !== undefined &&
			(typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)
		) {
			return { valid: false, error: `${field} must be a finite non-negative number` };
		}
	}
	for (const field of ['outputOriginalChars', 'outputReturnedChars'] as const) {
		const count = candidate[field];
		if (count !== undefined && (!Number.isSafeInteger(count) || (count as number) < 0)) {
			return { valid: false, error: `${field} must be a non-negative safe integer` };
		}
	}
	if (
		typeof candidate.outputReturnedChars === 'number' &&
		candidate.outputReturnedChars > MAX_TOTAL_CHARS
	) {
		return { valid: false, error: `outputReturnedChars cannot exceed ${MAX_TOTAL_CHARS}` };
	}
	for (const field of ['outputTruncated', 'chunkWriteFailed'] as const) {
		if (candidate[field] !== undefined && typeof candidate[field] !== 'boolean') {
			return { valid: false, error: `${field} must be a boolean` };
		}
	}
	for (const field of ['output', 'error'] as const) {
		if (candidate[field] !== undefined && typeof candidate[field] !== 'string') {
			return { valid: false, error: `${field} must be a string` };
		}
	}
	if (candidate.runtimeIdentity !== undefined) {
		if (
			typeof candidate.runtimeIdentity !== 'object' ||
			candidate.runtimeIdentity === null ||
			Array.isArray(candidate.runtimeIdentity)
		) {
			return { valid: false, error: 'runtimeIdentity must be an object' };
		}
		const identity = candidate.runtimeIdentity as Record<string, unknown>;
		for (const field of ['userName', 'userId', 'roles', 'scopeName']) {
			if (identity[field] !== undefined && typeof identity[field] !== 'string') {
				return { valid: false, error: `runtimeIdentity.${field} must be a string` };
			}
		}
		if (identity.isInteractive !== undefined && typeof identity.isInteractive !== 'boolean') {
			return { valid: false, error: 'runtimeIdentity.isInteractive must be a boolean' };
		}
	}
	return { valid: true, envelope: candidate as unknown as MailboxEnvelope };
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
	envelope?: Pick<MailboxEnvelope, 'outputReturnedChars' | 'payloadChecksum'>,
): ReassemblyResult {
	const byIndex = new Map<number, string>();
	const duplicates: number[] = [];

	for (const row of rows) {
		const name = row?.name;
		if (!name) continue;
		const prefix = `${parentKey}.chunk.`;
		if (!name.startsWith(prefix)) continue;
		const suffix = name.slice(prefix.length);
		if (!/^\d+$/.test(suffix)) continue;
		const index = Number.parseInt(suffix, 10);
		if (!Number.isInteger(index) || index < 0 || index >= chunkCount) continue;
		if (byIndex.has(index)) {
			duplicates.push(index);
			continue;
		}
		if (typeof row.value === 'string' && row.value.length <= CHUNK_CHARS) {
			byIndex.set(index, row.value);
		}
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

	const payload = parts.join('');
	if (
		envelope?.outputReturnedChars !== undefined &&
		payload.length !== envelope.outputReturnedChars
	) {
		problems.push(
			`payload length mismatch: expected ${envelope.outputReturnedChars}, received ${payload.length}`,
		);
	}
	if (
		envelope?.payloadChecksum !== undefined &&
		payloadChecksum(payload) !== envelope.payloadChecksum
	) {
		problems.push('payload checksum mismatch');
	}
	return {
		payload,
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
	  var __checksum = ${payloadChecksum.toString()};
	  var __writtenChunks = [];
	  var __deleteWrittenChunks = function() {
	    for (var __d = 0; __d < __writtenChunks.length; __d++) {
	      try {
	        var __dg = new GlideRecord('sys_properties');
	        if (__dg.get('name', __writtenChunks[__d])) { __dg.deleteRecord(); }
	      } catch (__deleteError) {}
	    }
	  };
		  var __writeChunks = function(text, originalChars, isActive) {
		    var __original = typeof originalChars === 'number' ? originalChars : text.length;
	    var __capped = text.length > ${MAX_TOTAL_CHARS} ? text.substring(0, ${MAX_TOTAL_CHARS}) : text;
	    var __count = 0;
	    var __failed = false;
	    var __position = 0;
	    for (var __i = 0; __position < __capped.length && __i < ${MAX_CHUNKS}; __i++) {
	      if (isActive && !isActive()) {
	        __deleteWrittenChunks(__count);
	        return {count: 0, truncated: __original > ${MAX_TOTAL_CHARS}, originalChars: __original, returnedChars: 0, failed: false, cancelled: true};
	      }
	      var __end = Math.min(__position + ${CHUNK_CHARS}, __capped.length);
	      var __last = __capped.charCodeAt(__end - 1);
	      if (__last >= 0xD800 && __last <= 0xDBFF) { __end--; }
	      if (__end <= __position) { break; }
	      var __slice = __capped.substring(__position, __end);
	      __position = __end;
	      try {
	        var __cg = new GlideRecord('sys_properties');
	        __cg.initialize();
	        __cg.setValue('name', ${parentKeyLiteral} + '.chunk.' + __i);
	        __cg.setValue('value', __slice);
	        __cg.setValue('description', 'Temporary MCP background-script output chunk — safe to delete');
	        __cg.setValue('type', 'string');
	        __cg.setValue('ignore_cache', true);
	        if (!__cg.insert()) { __failed = true; }
	        else { __count++; __writtenChunks.push(${parentKeyLiteral} + '.chunk.' + __i); }
	      } catch (__e) { __failed = true; }
	      if (isActive && !isActive()) {
	        __deleteWrittenChunks(__count);
	        return {count: 0, truncated: __original > ${MAX_TOTAL_CHARS}, originalChars: __original, returnedChars: 0, failed: false, cancelled: true};
	      }
	    }
	    return {
	      count: __count,
	      truncated: __original > __position,
	      originalChars: __original,
	      returnedChars: __position,
	      checksum: __checksum(__capped.substring(0, __position)),
	      failed: __failed,
	      cancelled: false
	    };
	  };
	`;
}
