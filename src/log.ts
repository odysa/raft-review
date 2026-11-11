// Structured logs: one JSON object per line on stdout (info) / stderr (warn,
// error). LOG_LEVEL=silent turns them off (tests); default "info".

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function threshold(): number {
  const env = (process.env.LOG_LEVEL ?? "info") as Level | "silent";
  return ORDER[env] ?? ORDER.info;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields });
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}
