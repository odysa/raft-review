// Compile LaTeX projects with Tectonic in a throwaway directory.
//
// Safety: `--untrusted` disables shell-escape and other known-insecure
// features; the child gets a minimal environment, a hard timeout and its own
// temp dir; sources that try to read files outside the project (absolute
// paths or `..` in \input-like commands) are refused before compiling. Run
// the service as an unprivileged user (the Docker image does).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ProjectFile {
  path: string;
  data: Uint8Array;
}

export interface CompileResult {
  ok: boolean;
  pdf?: Uint8Array;
  synctex?: Uint8Array;
  log: string;
  ms: number;
}

export interface Compiler {
  readonly name: string;
  compile(files: ProjectFile[], mainPath: string): Promise<CompileResult>;
}

const FILE_READING = /\\(input|include|InputIfFileExists|IfFileExists|openin|includegraphics|includepdf|lstinputlisting|verbatiminput|VerbatimInput|inputminted|addbibresource|bibliography|subfile|import|subimport)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;

/** Reject sources that reach outside the project directory. */
export function checkSourceSafety(files: ProjectFile[]): string | null {
  for (const f of files) {
    if (!/\.(tex|sty|cls|bib|bbx|cbx|def|cfg|ltx|dtx|ins)$/i.test(f.path)) continue;
    const text = Buffer.from(f.data).toString("utf8");
    for (const m of text.matchAll(FILE_READING)) {
      for (const target of m[2].split(",").map((t) => t.trim())) {
        if (target.startsWith("/") || target.startsWith("~") || /^[A-Za-z]:/.test(target) || target.split(/[\\/]/).includes("..")) {
          return `${f.path}: \\${m[1]}{${target}} reads outside the project; use a path inside it`;
        }
      }
    }
    if (/\\write18|\\immediate\s*\\write18|\\ShellEscape/.test(text)) return `${f.path}: shell escape is not allowed`;
  }
  return null;
}

/** Safe relative project path or null. */
export function safeProjectPath(p: string): string | null {
  const norm = p.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!norm || norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return null;
  const parts = norm.split("/");
  if (parts.some((s) => s === ".." || s === "" || s === ".")) return null;
  if (parts.some((s) => s.startsWith("__MACOSX") || s === ".DS_Store")) return null;
  return parts.join("/");
}

export function findTectonic(explicit?: string): string | null {
  if (explicit) return explicit;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["tectonic"], { encoding: "utf8" });
  const found = r.status === 0 ? r.stdout.trim().split("\n")[0] : "";
  return found || null;
}

export function createTectonicCompiler(opts: {
  binary: string;
  timeoutMs?: number;
  concurrency?: number;
  onlyCached?: boolean;
  maxLogBytes?: number;
}): Compiler {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxLog = opts.maxLogBytes ?? 64 * 1024;
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => new Promise<void>((resolve) => {
    if (running < (opts.concurrency ?? 2)) { running++; resolve(); } else waiting.push(() => { running++; resolve(); });
  });
  const release = () => { running--; waiting.shift()?.(); };

  return {
    name: "tectonic",
    async compile(files, mainPath) {
      const started = Date.now();
      const unsafe = checkSourceSafety(files);
      if (unsafe) return { ok: false, log: unsafe, ms: 0 };
      await acquire();
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raft-review-"));
      try {
        for (const f of files) {
          const rel = safeProjectPath(f.path);
          if (!rel) continue;
          const dest = path.join(dir, rel);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, f.data);
        }
        const out = path.join(dir, ".raft-out");
        await fs.mkdir(out);
        const main = safeProjectPath(mainPath);
        if (!main) return { ok: false, log: `invalid main file path ${JSON.stringify(mainPath)}`, ms: 0 };
        // "./" keeps a file named like "-o…" from being read as a flag.
        const args = ["-X", "compile", `./${main}`, "--untrusted", "--synctex", "--keep-logs", "--outdir", out];
        if (opts.onlyCached) args.push("--only-cached");
        const { code, output, timedOut } = await run(opts.binary, args, dir, timeoutMs);
        const base = mainPath.replace(/\.tex$/i, "");
        const pdf = await fs.readFile(path.join(out, `${path.basename(base)}.pdf`)).catch(() => null);
        const synctex = await fs.readFile(path.join(out, `${path.basename(base)}.synctex.gz`)).catch(() => null);
        const texLog = await fs.readFile(path.join(out, `${path.basename(base)}.log`), "utf8").catch(() => "");
        let log = (timedOut ? `Compile timed out after ${Math.round(timeoutMs / 1000)} s.\n` : "") + output + (texLog ? `\n--- ${path.basename(base)}.log ---\n${texLog}` : "");
        // Don't leak the server's temp path into logs shown to users.
        log = log.split(dir).join(".");
        if (log.length > maxLog) log = `${log.slice(0, maxLog / 2)}\n…\n${log.slice(-maxLog / 2)}`;
        const ok = code === 0 && !!pdf;
        return {
          ok,
          pdf: ok && pdf ? new Uint8Array(pdf) : undefined,
          synctex: ok && synctex ? new Uint8Array(synctex) : undefined,
          log,
          ms: Date.now() - started,
        };
      } finally {
        release();
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

function run(binary: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      cwd,
      // Minimal environment: no secrets from the app's env reach TeX.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? cwd,
        LANG: "C.UTF-8",
        ...(process.env.XDG_CACHE_HOME ? { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const append = (b: Buffer) => { if (output.length < 256 * 1024) output += b.toString("utf8"); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output, timedOut }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ code: -1, output: `failed to start compiler: ${err.message}`, timedOut }); });
  });
}
