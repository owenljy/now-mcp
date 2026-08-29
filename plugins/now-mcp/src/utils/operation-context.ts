import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationContext {
	operationId: string;
	instance: string;
	tool: string;
}

const storage = new AsyncLocalStorage<OperationContext>();

/** Run a tool call with correlation data available to every async descendant. */
export function runWithOperationContext<T>(
	context: OperationContext,
	fn: () => Promise<T>,
): Promise<T> {
	return storage.run(context, fn);
}

/** Correlation data for the current tool call, absent in startup/tests/direct use. */
export function getOperationContext(): OperationContext | undefined {
	return storage.getStore();
}
