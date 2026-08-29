/**
 * Logger utility for MCP server
 * CRITICAL: All logging must go to stderr (not stdout)
 * stdout is reserved for the MCP protocol communication
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

import { sanitizeLogData } from './log-safety.js';

/**
 * MCP logging levels we actually emit. 'warn' maps to the MCP spec's 'warning'
 * (the full spec enum also has notice/critical/alert/emergency, which we don't
 * use). A sink receives the mapped level plus a structured data payload.
 */
export type McpLogLevel = 'debug' | 'info' | 'warning' | 'error';
export type McpLogSender = (entry: { level: McpLogLevel; data: unknown }) => void;

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

const MCP_LEVELS: Record<LogLevel, McpLogLevel> = {
	debug: 'debug',
	info: 'info',
	warn: 'warning',
	error: 'error',
};

class Logger {
	private level: LogLevel;
	private mcpSender: McpLogSender | null = null;

	constructor(level: LogLevel = 'info') {
		this.level = level;
	}

	/**
	 * Attach (or detach with null) an MCP sink. When attached, every log that
	 * passes the level filter is ALSO forwarded to the MCP client — the existing
	 * stderr output is always kept as a fallback. Forwarding is wrapped in
	 * try/catch so logging can never throw into the server.
	 */
	setMcpSender(sender: McpLogSender | null): void {
		this.mcpSender = sender;
	}

	private forwardToMcp(level: LogLevel, message: string, data?: unknown): void {
		const sender = this.mcpSender;
		if (!sender) return;
		try {
			const payload = data !== undefined ? { message, data: sanitizeLogData(data) } : { message };
			sender({ level: MCP_LEVELS[level], data: payload });
		} catch {
			// Never let MCP forwarding surface an error — stderr already has the log.
		}
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	private shouldLog(level: LogLevel): boolean {
		return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
	}

	private formatMessage(level: LogLevel, message: string, data?: unknown): string {
		const timestamp = new Date().toISOString();
		const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

		if (data !== undefined) {
			const safeData = sanitizeLogData(data);
			const dataStr =
				typeof safeData === 'object' ? JSON.stringify(safeData, null, 2) : String(safeData);
			return `${prefix} ${message}\n${dataStr}`;
		}

		return `${prefix} ${message}`;
	}

	debug(message: string, data?: unknown): void {
		if (this.shouldLog('debug')) {
			console.error(this.formatMessage('debug', message, data));
			this.forwardToMcp('debug', message, data);
		}
	}

	info(message: string, data?: unknown): void {
		if (this.shouldLog('info')) {
			console.error(this.formatMessage('info', message, data));
			this.forwardToMcp('info', message, data);
		}
	}

	warn(message: string, data?: unknown): void {
		if (this.shouldLog('warn')) {
			console.error(this.formatMessage('warn', message, data));
			this.forwardToMcp('warn', message, data);
		}
	}

	error(message: string, error?: unknown): void {
		if (this.shouldLog('error')) {
			const errorData =
				error instanceof Error
					? { message: error.message, stack: error.stack, name: error.name }
					: error;
			console.error(this.formatMessage('error', message, errorData));
			this.forwardToMcp('error', message, errorData);
		}
	}
}

// Create singleton logger instance
export const logger = new Logger();

// Allow updating log level from environment
export function initializeLogger(level?: LogLevel): void {
	if (level) {
		logger.setLevel(level);
	}
}
