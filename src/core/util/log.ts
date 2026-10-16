/**
 * Logger that only ever writes to stderr. The MCP stdio transport owns stdout, so any
 * stray console.log would corrupt the protocol stream.
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

let current: LogLevel = (process.env.AGENTCMS_LOG as LogLevel | undefined) ?? "warn";

export function setLogLevel(level: LogLevel): void {
  current = level;
}

function emit(level: Exclude<LogLevel, "silent">, args: unknown[]): void {
  if (order[level] < order[current]) return;
  const line = args
    .map((a) =>
      typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a),
    )
    .join(" ");
  process.stderr.write(`[agentcms:${level}] ${line}\n`);
}

export const log = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
