import { spawn } from 'node:child_process';

export interface ProcessResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	reason?: 'timeout' | 'cancelled' | 'output_limit' | 'spawn_failed' | 'exit_failed';
}

/** Bounded asynchronous subprocess; never blocks MCP timers or other tool calls. */
export function runProcess(
	command: string,
	args: string[],
	options: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number },
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ ok: false, stdout: '', stderr: '', reason: 'cancelled' });
			return;
		}
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
		const stdout: Buffer[] = [],
			stderr: Buffer[] = [];
		let bytes = 0;
		let reason: ProcessResult['reason'];
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const stop = (why: ProcessResult['reason']) => {
			if (reason) return;
			reason = why;
			child.kill('SIGTERM');
			killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
		};
		const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
		const abort = () => stop('cancelled');
		options.signal?.addEventListener('abort', abort, { once: true });
		const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > (options.maxBytes ?? 2 * 1024 * 1024)) stop('output_limit');
			else chunks.push(chunk);
		};
		child.stdout.on('data', collect(stdout));
		child.stderr.on('data', collect(stderr));
		child.on('error', () => {
			reason = 'spawn_failed';
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			options.signal?.removeEventListener('abort', abort);
			resolve({
				ok: code === 0 && !reason,
				stdout: Buffer.concat(stdout).toString('utf8'),
				stderr: Buffer.concat(stderr).toString('utf8'),
				...(reason || code !== 0 ? { reason: reason ?? 'exit_failed' } : {}),
			});
		});
	});
}
