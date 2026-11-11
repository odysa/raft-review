// Line diff (Myers, O(ND)) and unified-diff output, so an agent can apply
// accepted review changes to the paper's real repository with `git apply`.

type Op = { kind: "eq" | "del" | "ins"; line: string };

export function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Array<Map<number, number>> = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Backtrack.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ kind: "eq", line: a[x - 1] }); x--; y--; }
    if (d > 0) {
      if (x === prevX) ops.push({ kind: "ins", line: b[y - 1] });
      else ops.push({ kind: "del", line: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

const NO_EOL = "\u0000no-eol";

/** Split into lines; a last line without "\n" is tagged so it never equals
 *  the same text with a newline, and gets git's marker when printed. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  else lines[lines.length - 1] += NO_EOL;
  return lines;
}

function printLine(prefix: string, line: string): string {
  return line.endsWith(NO_EOL) ? `${prefix}${line.slice(0, -NO_EOL.length)}\n\\ No newline at end of file` : `${prefix}${line}`;
}

/** Unified diff for one file (`git apply`-compatible). Empty string when equal. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
  if (before === after) return "";
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const ops = diffLines(a, b);
  const header = [
    `diff --git a/${path} b/${path}`,
    ...(before === null ? ["new file mode 100644"] : after === null ? ["deleted file mode 100644"] : []),
    `--- ${before === null ? "/dev/null" : `a/${path}`}`,
    `+++ ${after === null ? "/dev/null" : `b/${path}`}`,
  ];
  let aLine = 1;
  let bLine = 1;
  const positions = ops.map((op) => {
    const pos = { a: aLine, b: bLine };
    if (op.kind !== "ins") aLine++;
    if (op.kind !== "del") bLine++;
    return pos;
  });
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "eq") { i++; continue; }
    const start = Math.max(0, i - context);
    let lastChange = i;
    let j = i;
    while (j < ops.length && (ops[j].kind !== "eq" || j - lastChange <= context * 2)) {
      if (ops[j].kind !== "eq") lastChange = j;
      j++;
    }
    const end = Math.min(ops.length, lastChange + context + 1);
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.kind !== "ins").length;
    const bCount = slice.filter((o) => o.kind !== "del").length;
    const aStart = aCount ? positions[start].a : positions[start].a - 1;
    const bStart = bCount ? positions[start].b : positions[start].b - 1;
    const body = slice.map((o) => printLine(o.kind === "eq" ? " " : o.kind === "del" ? "-" : "+", o.line)).join("\n");
    hunks.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@\n${body}`);
    i = end;
  }
  return `${header.join("\n")}\n${hunks.join("\n")}\n`;
}

/** Patch across a whole project between two file maps. */
export function projectPatch(before: Map<string, string>, after: Map<string, string>): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((p) => unifiedDiff(p, before.get(p) ?? null, after.get(p) ?? null)).join("");
}
