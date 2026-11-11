// Minimal SyncTeX reader for backward search: (page, x, y) in the PDF →
// (source file, line). Format: https://github.com/jlaurens/synctex
//   Input:<tag>:<path>        source files
//   {<page> … }<page>          page content
//   [tag,line:x,y:w,h,d        vbox     (tag,line:x,y:w,h,d   hbox
//   x tag,line:x,y  k … g … $ …  kern / glue / math / current point records
// Coordinates are scaled points (65536 sp = 1 TeX pt; 72.27 pt = 72 PDF bp),
// measured from the page's top-left corner.

import { gunzipSync } from "node:zlib";
import path from "node:path";

interface SyncRecord {
  tag: number;
  line: number;
  x: number;
  y: number;
  w: number;
  h: number;
  d: number;
  box: boolean;
}

export interface SyncTex {
  inputs: Map<number, string>;
  pages: Map<number, SyncRecord[]>;
}

const SP_PER_BP = 65536 * 72.27 / 72;

/** Parse a .synctex(.gz) file. `root` is the compile directory; input paths
 *  are made relative to it so they match project file paths. */
export function parseSyncTex(data: Uint8Array, root: string): SyncTex {
  const isGzip = data[0] === 0x1f && data[1] === 0x8b;
  const text = Buffer.from(isGzip ? gunzipSync(data) : data).toString("utf8");
  const inputs = new Map<number, string>();
  const pages = new Map<number, SyncRecord[]>();
  let unit = 1;
  let xOffset = 0;
  let yOffset = 0;
  let page = 0;
  let records: SyncRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("Input:")) {
      const rest = line.slice(6);
      const colon = rest.indexOf(":");
      const tag = Number(rest.slice(0, colon));
      const file = rest.slice(colon + 1);
      if (file) {
        const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
        inputs.set(tag, rel.split(path.sep).join("/").replace(/^\.\//, ""));
      }
      continue;
    }
    if (line.startsWith("Unit:")) { unit = Number(line.slice(5)) || 1; continue; }
    if (line.startsWith("X Offset:")) { xOffset = Number(line.slice(9)) || 0; continue; }
    if (line.startsWith("Y Offset:")) { yOffset = Number(line.slice(9)) || 0; continue; }
    const kind = line[0];
    if (kind === "{") {
      page = Number(line.slice(1));
      records = [];
      continue;
    }
    if (kind === "}") {
      pages.set(page, records);
      continue;
    }
    if (!page || !"[(xkg$hv".includes(kind ?? "")) continue;
    const m = /^.(\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/.exec(line);
    if (!m) continue;
    records.push({
      tag: Number(m[1]),
      line: Number(m[2]),
      x: (Number(m[3]) * unit) + xOffset,
      y: (Number(m[4]) * unit) + yOffset,
      w: m[5] !== undefined ? Number(m[5]) * unit : 0,
      h: m[6] !== undefined ? Number(m[6]) * unit : 0,
      d: m[7] !== undefined ? Number(m[7]) * unit : 0,
      box: kind === "(" || kind === "[" || kind === "h" || kind === "v",
    });
  }
  return { inputs, pages };
}

/** Backward search: PDF point in bp from the page's top-left → file/line. */
export function syncTexLookup(sync: SyncTex, page: number, xBp: number, yBp: number): { path: string; line: number } | null {
  const records = sync.pages.get(page);
  if (!records?.length) return null;
  const x = xBp * SP_PER_BP;
  const y = yBp * SP_PER_BP;
  let best: SyncRecord | null = null;
  let bestScore = Infinity;
  for (const r of records) {
    if (r.line <= 0 || !sync.inputs.has(r.tag)) continue;
    let score: number;
    if (r.box && r.w > 0) {
      const inside = x >= r.x && x <= r.x + r.w && y >= r.y - Math.max(r.h, 65536 * 6) && y <= r.y + Math.max(r.d, 65536 * 3);
      // Smallest enclosing box wins; otherwise distance to the box.
      score = inside ? r.w * (r.h + r.d + 1) / 1e12 : 1e6 + boxDistance(r, x, y);
    } else {
      score = 1e6 + Math.hypot(r.x - x, (r.y - y) * 2);
    }
    if (score < bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best) return null;
  const file = sync.inputs.get(best.tag);
  return file ? { path: file, line: best.line } : null;
}

function boxDistance(r: SyncRecord, x: number, y: number): number {
  const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
  const dy = y < r.y - r.h ? r.y - r.h - y : y > r.y + r.d ? y - (r.y + r.d) : 0;
  return Math.hypot(dx, dy * 2);
}
