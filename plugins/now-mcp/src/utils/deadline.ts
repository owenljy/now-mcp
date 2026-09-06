import { ServiceNowError } from '../types/errors.js';

export class DeadlineExceededError extends ServiceNowError {
	constructor() {
		super('Request deadline exceeded', undefined, undefined, 'REQUEST_DEADLINE_EXCEEDED');
	}
}

export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
	});
}

export async function withDeadline<T>(
	deadline: number,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new DeadlineExceededError();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DeadlineExceededError()), remaining);
	try {
		return await work(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
