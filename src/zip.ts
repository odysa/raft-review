// Safe zip handling for LaTeX projects: no path traversal, bounded size and
// file count (zip bombs), junk entries dropped, single top-level folder
// flattened (GitHub/Overleaf exports wrap everything in one directory).

import { unzipSync, zipSync, type Unzipped } from "fflate";

import { safeProjectPath, type ProjectFile } from "./compile.ts";

export const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
export const MAX_PROJECT_FILES = 2000;

export class ZipError extends Error {}

export function unzipProject(data: Uint8Array): ProjectFile[] {
  let total = 0;
  let count = 0;
  let entries: Unzipped;
  try {
    entries = unzipSync(data, {
      filter: (file) => {
        if (file.name.endsWith("/")) return false;
        count++;
        total += file.originalSize;
        if (count > MAX_PROJECT_FILES) throw new ZipError(`too many files (max ${MAX_PROJECT_FILES})`);
        if (total > MAX_PROJECT_BYTES) throw new ZipError(`project is too large when unpacked (max ${MAX_PROJECT_BYTES / 1024 / 1024} MB)`);
        return safeProjectPath(file.name) !== null;
      },
    });
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError("not a valid zip file");
  }
  let files = Object.entries(entries).map(([name, bytes]) => ({ path: safeProjectPath(name)!, data: bytes }));
  // Flatten a single wrapping folder.
  const tops = new Set(files.map((f) => f.path.split("/")[0]));
  if (tops.size === 1 && files.every((f) => f.path.includes("/"))) {
    const top = [...tops][0];
    files = files.map((f) => ({ path: f.path.slice(top.length + 1), data: f.data }));
  }
  return files.filter((f) => !/(^|\/)\.(git|DS_Store)(\/|$)/.test(f.path));
}

export function zipProject(files: ProjectFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((f) => [f.path, f.data])), { level: 6 });
}

export function isTextPath(p: string): boolean {
  return /\.(tex|sty|cls|bib|bbx|cbx|bst|def|cfg|ltx|txt|md|csv|dat|tikz|pgf|latexmkrc)$/i.test(p) || !p.includes(".");
}

/** Pick the root .tex: main.tex if present, else the one with \documentclass. */
export function detectMainFile(files: ProjectFile[]): string | null {
  const tex = files.filter((f) => /\.tex$/i.test(f.path));
  const roots = tex.filter((f) => /\\documentclass/.test(Buffer.from(f.data).toString("utf8")));
  const pick = (list: ProjectFile[]) =>
    list.find((f) => /(^|\/)main\.tex$/i.test(f.path))
    ?? list.find((f) => /(^|\/)(paper|article|manuscript|ms)\.tex$/i.test(f.path))
    ?? [...list].sort((x, y) => x.path.split("/").length - y.path.split("/").length)[0];
  return pick(roots)?.path ?? null;
}
