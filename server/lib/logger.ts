// Structured logging only — no PII. Every log line is a flat JSON object so
// Cloud Run's log sink can parse it without extra config (ponytail: no
// logging library, console.log is enough for one service's stdout).
type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ severity: level.toUpperCase(), message, ...fields, ts: new Date().toISOString() });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>) => emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => emit("error", message, fields),
};
