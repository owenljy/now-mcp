import { type Node, parse } from 'acorn';
import { ServiceNowError } from '../types/errors.js';

/** Replace only executable gs logging calls; preserve literals, comments and regexes. */
export function rewriteScriptLogs(script: string): string {
	let root: Node;
	try {
		root = parse(script, { ecmaVersion: 'latest', allowReturnOutsideFunction: true });
	} catch {
		throw new ServiceNowError(
			'Script could not be parsed safely for output capture. Check JavaScript syntax before execution.',
			400,
			undefined,
			'BACKGROUND_SCRIPT_PARSE_ERROR',
		);
	}
	const edits: Array<{ start: number; end: number }> = [];
	const visit = (node: Node) => {
		const value = node as Node & Record<string, unknown>;
		if (node.type === 'CallExpression') {
			const callee = value.callee as Node & {
				computed?: boolean;
				object?: { type: string; name: string };
				property?: { type: string; name: string };
			};
			if (
				callee.type === 'MemberExpression' &&
				!callee.computed &&
				callee.object?.type === 'Identifier' &&
				callee.object.name === 'gs' &&
				callee.property?.type === 'Identifier' &&
				['log', 'info', 'print'].includes(callee.property.name)
			) {
				edits.push({ start: callee.start, end: callee.end });
			}
		}
		for (const child of Object.values(value)) {
			if (Array.isArray(child)) {
				for (const item of child) if (item && typeof item.type === 'string') visit(item);
			} else if (
				child &&
				typeof child === 'object' &&
				'type' in child &&
				typeof child.type === 'string'
			) {
				visit(child as Node);
			}
		}
	};
	visit(root);
	for (const edit of edits.sort((a, b) => b.start - a.start)) {
		script = `${script.slice(0, edit.start)}log${script.slice(edit.end)}`;
	}
	return script;
}
