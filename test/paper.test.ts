import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { zipSync } from "fflate";

import { checkSourceSafety, createTectonicCompiler, findTectonic } from "../src/compile.ts";
import type { Config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { contextOf, indexLatex, indexPlain, locate, mathSpanAround, projectLatex, tidySourceSpan } from "../src/latex.ts";
import { createApp } from "../src/server.ts";
import { parseSyncTex, syncTexLookup } from "../src/synctex.ts";
import { unzipProject, ZipError } from "../src/zip.ts";

const enc = new TextEncoder();
const MAIN = String.raw`\documentclass{article}
\usepackage{amsmath}
\title{Attention Is Mostly What You Need}
\author{A. Lovelace}
\begin{document}
\maketitle
\begin{abstract}
We show that our method \emph{outperforms all prior work} by a significant
margin on every benchmark we tried~\cite{vaswani}. These results prove that attention is sufficient.
\end{abstract}
\input{sections/method}
\end{document}
`;
const METHOD = String.raw`\section{Method}
We train a transformer with twelve layers for three days on 8~GPUs.
Hyperparameters were chosen by intuition. The loss is
\begin{equation}
  \mathcal{L} = -\sum_t \log p(x_t \mid x_{<t}).
\end{equation}
`;
const project = () => ({ "main.tex": enc.encode(MAIN), "sections/method.tex": enc.encode(METHOD) });

describe("LaTeX ↔ PDF text mapping", () => {
  test("projection drops markup, math, cites and comments; keeps wrapped text", () => {
    const src = "A \\emph{bold} claim~\\cite{x} with $x^2$ math % comment\n\\textbf{and} ``quotes'' -- dash\\footnote{note}.";
    const p = projectLatex(src).text;
    assert.equal(p.replace(/\s+/g, " ").trim(), "A bold claim with x2 math and \"quotes\" - dash note.");
  });

  test("a PDF quote with hyphenation and ligatures maps to exact source", () => {
    const pdf = "Hyperpa-\nrameters were chosen by intuition.";
    const m = locate(indexLatex(METHOD), indexPlain(pdf).norm)!;
    assert.equal(METHOD.slice(m.start, m.end), "Hyperparameters were chosen by intuition.");
    const lig = locate(indexLatex("We find ﬁve ﬂaws."), indexPlain("We ﬁnd five flaws.").norm);
    assert.ok(lig, "ligatures normalize on both sides");
  });

  test("emphasized and cited text matches with markup removed", () => {
    const m = locate(indexLatex(MAIN), indexPlain("our method outperforms all prior work by a significant\nmargin").norm)!;
    assert.match(MAIN.slice(m.start, m.end), /^our method \\emph\{outperforms all prior work\} by a significant\nmargin$/);
  });
});

describe("equations, tables and repeated phrases", () => {
  test("typeset equation text maps to its LaTeX", () => {
    // What PDF.js extracts for the equation in METHOD.
    const pdf = "L = − ∑\nt\nlog p(xt | x<t). (1)";
    const m = locate(indexLatex(METHOD), indexPlain(pdf).norm)!;
    assert.ok(m, "found");
        const t = tidySourceSpan(METHOD, m);
    assert.match(METHOD.slice(t.start, t.end), /^\\mathcal\{L\} = -\\sum_t \\log p\(x_t \\mid x_\{<t\}\)\.?$/);
  });

  test("a table row maps to its source row", () => {
    const tex = String.raw`\begin{tabular}{lrr}\toprule Model & PG-19 ppl & Speed \\ \midrule
Dense & 18.2 & 1.0$\times$ \\
Sparse Routing & 18.0 & 3.1$\times$ \\ \bottomrule\end{tabular}`;
    const m = tidySourceSpan(tex, locate(indexLatex(tex), indexPlain("Sparse Routing 18.0 3.1×").norm)!);
    assert.equal(tex.slice(m.start, m.end), "Sparse Routing & 18.0 & 3.1$\\times$");
  });

  test("a repeated phrase resolves by the text around it, without SyncTeX", () => {
    const tex = "Our first experiment shows the model is robust to noise in the inputs.\n\n"
      + "A second ablation removes the router; again the model is robust to noise, which surprised us.\n";
    const pdf = "Our first experiment shows the model is robust to noise in the inputs.\nA second ablation removes the router; again the model\nis robust to noise, which surprised us.";
    const quote = "the model\nis robust to noise";
    const start = pdf.indexOf(quote);
    const idx = indexPlain(pdf);
    const ctx = contextOf(idx, { start, end: start + quote.length });
    const m = locate(indexLatex(tex), indexPlain(quote).norm, undefined, ctx)!;
    assert.ok(m.start > tex.indexOf("second"), `picked the second occurrence (got offset ${m.start})`);
    const without = locate(indexLatex(tex), indexPlain(quote).norm)!;
    assert.ok(without.start < tex.indexOf("second"), "without context the first occurrence would win");
  });

  test("mathSpanAround returns the whole equation for a line inside it", () => {
    const span = mathSpanAround(METHOD, 5)!;
    assert.match(METHOD.slice(span.start, span.end), /^\\begin\{equation\}[\s\S]*\\end\{equation\}$/);
  });
});

describe("zip safety", () => {
  test("flattens one wrapping folder and drops junk", () => {
    const zip = zipSync({ "paper/main.tex": enc.encode("x"), "paper/fig/a.png": new Uint8Array([1]), "__MACOSX/paper/._main.tex": enc.encode("") });
    assert.deepEqual(unzipProject(zip).map((f) => f.path).sort(), ["fig/a.png", "main.tex"]);
  });
  test("refuses traversal paths and oversized archives", () => {
    const evil = zipSync({ "../../etc/x.tex": enc.encode("x"), "ok.tex": enc.encode("y") });
    assert.deepEqual(unzipProject(evil).map((f) => f.path), ["ok.tex"]);
    const big = zipSync({ "a.tex": new Uint8Array(60 * 1024 * 1024) }, { level: 9 });
    assert.throws(() => unzipProject(big), ZipError);
  });
  test("sources that read outside the project are refused before compiling", () => {
    assert.match(checkSourceSafety([{ path: "main.tex", data: enc.encode(String.raw`\input{/etc/passwd}`) }])!, /outside the project/);
    assert.match(checkSourceSafety([{ path: "main.tex", data: enc.encode(String.raw`\include{../secret}`) }])!, /outside the project/);
    assert.equal(checkSourceSafety([{ path: "main.tex", data: enc.encode(String.raw`\input{sections/method}`) }]), null);
  });
});

const tectonic = findTectonic();

describe("with Tectonic", { skip: tectonic ? false : "tectonic not installed" }, () => {
  test("SyncTeX backward search finds the right source file", async () => {
    const compiler = createTectonicCompiler({ binary: tectonic!, timeoutMs: 60_000 });
    const files = Object.entries(project()).map(([p, data]) => ({ path: p, data }));
    const result = await compiler.compile(files, "main.tex");
    assert.ok(result.ok, result.log);
    const sync = parseSyncTex(result.synctex!, "/");
    const paths = [...sync.inputs.values()];
    assert.ok(paths.some((p) => p.endsWith("sections/method.tex")));
    // The Method section sits below the abstract on page 1.
    const hits = new Set<string>();
    for (let y = 100; y < 500; y += 20) {
      const hit = syncTexLookup(sync, 1, 200, y);
      if (hit) hits.add(hit.path.split("/").pop()!);
    }
    assert.ok(hits.has("main.tex") && hits.has("method.tex"), [...hits].join(","));
  });

  test("a main file named like a flag is not treated as one", async () => {
    const compiler = createTectonicCompiler({ binary: tectonic!, timeoutMs: 60_000 });
    const r = await compiler.compile([{ path: "-Z.tex", data: enc.encode(String.raw`\documentclass{article}\begin{document}Hi\end{document}`) }], "-Z.tex");
    assert.ok(r.ok, r.log);
  });

  test("compile refuses \\input of a server file", async () => {
    const compiler = createTectonicCompiler({ binary: tectonic!, timeoutMs: 60_000 });
    const r = await compiler.compile([{ path: "main.tex", data: enc.encode(String.raw`\documentclass{article}\begin{document}\input{/etc/hosts}\end{document}`) }], "main.tex");
    assert.equal(r.ok, false);
    assert.match(r.log, /outside the project/);
  });
});

// ---------- end to end over HTTP ----------

function startApp(opts: { compiler?: "auto" | "none" } = {}) {
  let app!: ReturnType<typeof createApp>;
  const server = http.createServer((req, res) => void app.handle(req, res));
  return new Promise<{ base: string; app: ReturnType<typeof createApp>; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://localhost:${(server.address() as AddressInfo).port}`;
      const config: Config = {
        port: 0, publicUrl: base, raftApiUrl: "http://127.0.0.1:9", clientId: "", clientSecret: "", raftServerId: "",
        dataDir: ":memory:", devLogin: true, serviceKey: "raft-review", webhookSecrets: [],
        compiler: opts.compiler ?? "auto", compileTimeoutMs: 60_000, compileConcurrency: 1, tectonicOnlyCached: false,
      };
      app = createApp(config, { db: openDb(":memory:") });
      resolve({ base, app, close: () => server.close() });
    });
  });
}

async function login(base: string, type: "human" | "agent", name: string): Promise<string> {
  const res = await fetch(`${base}/auth/dev-login`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ type, name }) });
  return res.headers.getSetCookie()[0].split(";")[0];
}

function client(base: string, cookie: string) {
  return async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, {
      method,
      headers: { cookie, origin: base, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, body: type.includes("json") ? await res.json() : await res.text() };
  };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("paper review loop over HTTP", { skip: tectonic ? false : "tectonic not installed" }, () => {
  let env: Awaited<ReturnType<typeof startApp>>;
  before(async () => { env = await startApp(); });
  after(() => env.close());

  test("comment on the PDF → mapped LaTeX → agent edit → accept → recompiled PDF → git-applicable patch", async () => {
    const human = client(env.base, await login(env.base, "human", "Ada"));
    const agent = client(env.base, await login(env.base, "agent", "Scribe"));

    // Agent publishes the paper from its repo (zip, base64).
    const zip = Buffer.from(zipSync(project())).toString("base64");
    const created = await agent("POST", "/api/papers", { filename: "attention.zip", title: "Attention paper", zip_base64: zip });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id;
    assert.equal(created.body.paper.main_path, "main.tex");

    const ready = await waitFor(async () => {
      const d = (await human("GET", `/api/documents/${id}`)).body;
      return d.paper.compile.status === "ok" ? d : null;
    });
    assert.match(ready.text, /Hyperpa-?\n?rameters were chosen by intuition\./);

    // Human selects text in the PDF; the app finds the LaTeX.
    const pdfQuoteMatch = /Hyperpa-\nrameters were chosen by intuition\.|Hyperparameters were chosen by intuition\./.exec(ready.text)!;
    const start = pdfQuoteMatch.index;
    const end = start + pdfQuoteMatch[0].length;
    const preview = await human("POST", `/api/documents/${id}/map`, { start, end });
    assert.equal(preview.body.source.path, "sections/method.tex");
    assert.equal(preview.body.source.quote, "Hyperparameters were chosen by intuition.");
    assert.equal(preview.body.source.line, 3);

    const thread = await human("POST", `/api/documents/${id}/threads`, { start, end, quote: ready.text.slice(start, end), body: "Reviewers will flag this." });
    assert.equal(thread.status, 201, JSON.stringify(thread.body));
    const t = thread.body.thread;
    assert.equal(t.source.path, "sections/method.tex");
    assert.equal(t.source.quote, "Hyperparameters were chosen by intuition.");

    // Agent reads it with LaTeX context and suggests a source edit.
    const detail = await agent("GET", `/api/threads/${t.id}`);
    assert.match(detail.body.source_context.before, /8~GPUs/);
    const replacement = String.raw`We tuned the learning rate in $\{1,3\}\times10^{-4}$ on the validation split.`;
    const sug = await agent("POST", `/api/threads/${t.id}/suggestions`, { replacement, rationale: "State the search." });
    assert.equal(sug.status, 201, JSON.stringify(sug.body));
    const s = sug.body.thread.suggestions[0];
    assert.equal(s.path, "sections/method.tex");
    assert.equal(s.line, 3);

    // Human accepts: new source version, recompiled PDF, highlight follows.
    const acc = await human("POST", `/api/suggestions/${s.id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.body));
    assert.equal(acc.body.document.current_version, 2);
    const v2 = await waitFor(async () => {
      const d = (await human("GET", `/api/documents/${id}`)).body;
      return d.paper.compile.status === "ok" && /validation split/.test(d.text) ? d : null;
    });
    const t2 = v2.threads.find((x: any) => x.id === t.id);
    assert.match(v2.text.slice(t2.anchor.start, t2.anchor.end), /We tuned\s+the learning rate.*validation split\./s);
    assert.match(t2.source.quote, /^We tuned the learning rate/);

    // Patch for the agent's repo applies cleanly with git.
    const patch = await agent("GET", `/api/documents/${id}/patch?from=1`);
    assert.match(patch.body, /^diff --git a\/sections\/method\.tex b\/sections\/method\.tex/m);
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "rr-repo-"));
    try {
      fs.mkdirSync(path.join(repo, "sections"));
      fs.writeFileSync(path.join(repo, "main.tex"), MAIN);
      fs.writeFileSync(path.join(repo, "sections/method.tex"), METHOD);
      fs.writeFileSync(path.join(repo, "x.patch"), patch.body);
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["apply", "x.patch"], { cwd: repo });
      const file = await agent("GET", `/api/documents/${id}/file?path=sections/method.tex`);
      assert.equal(fs.readFileSync(path.join(repo, "sections/method.tex"), "utf8"), file.body.content);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }

    // Sources download as a zip of the current version.
    const z = await fetch(`${env.base}/api/documents/${id}/sources.zip`, { headers: { cookie: (await login(env.base, "agent", "Scribe")) } });
    const files = unzipProject(new Uint8Array(await z.arrayBuffer()));
    assert.match(new TextDecoder().decode(files.find((f) => f.path === "sections/method.tex")!.data), /validation split/);
  });

  test("comments on an equation and a table row map to their LaTeX", async () => {
    const human = client(env.base, await login(env.base, "human", "Ada"));
    const tableTex = String.raw`\begin{table}[h]\centering\begin{tabular}{lr}\toprule Model & ppl \\ \midrule Dense & 18.2 \\ Sparse Routing & 18.0 \\ \bottomrule\end{tabular}\caption{Results.}\end{table}`;
    const main = MAIN.replace("\\usepackage{amsmath}", "\\usepackage{amsmath,booktabs}")
      .replace("\\input{sections/method}", `\\input{sections/method}\n${tableTex}`);
    const created = await human("POST", "/api/papers", { title: "Eq", files: [{ path: "main.tex", content: main }, { path: "sections/method.tex", content: METHOD }] });
    const id = created.body.id;
    const doc = await waitFor(async () => {
      const d = (await human("GET", `/api/documents/${id}`)).body;
      if (d.paper.compile.status === "failed") assert.fail((await human("GET", `/api/documents/${id}/compile-log`)).body.log.slice(-1500));
      return d.paper.compile.status === "ok" ? d : null;
    });
    // Equation: select what PDF.js extracted for it.
    const eq = /L = − ∑[\s\S]*?x<t\)\./.exec(doc.text)!;
    const mapEq = await human("POST", `/api/documents/${id}/map`, { start: eq.index, end: eq.index + eq[0].length });
    assert.equal(mapEq.body.source.path, "sections/method.tex");
    assert.match(mapEq.body.source.quote, /\\sum_t \\log p\(x_t/);
    // Table row.
    const row = /Sparse Routing 18\.0/.exec(doc.text)!;
    const mapRow = await human("POST", `/api/documents/${id}/map`, { start: row.index, end: row.index + row[0].length });
    assert.equal(mapRow.body.source.path, "main.tex");
    assert.equal(mapRow.body.source.quote, "Sparse Routing & 18.0");
  });

  test("an agent can anchor a comment by quoting the LaTeX", async () => {
    const agent = client(env.base, await login(env.base, "agent", "Scribe"));
    const created = await agent("POST", "/api/papers", { title: "P2", files: [{ path: "main.tex", content: MAIN }, { path: "sections/method.tex", content: METHOD }] });
    const id = created.body.id;
    await waitFor(async () => ((await agent("GET", `/api/documents/${id}`)).body.paper.compile.status === "ok"));
    const th = await agent("POST", `/api/documents/${id}/threads`, { quote: "These results prove that attention is sufficient.", body: "Too strong.", replacement: "These results suggest that attention can be sufficient." });
    assert.equal(th.status, 201, JSON.stringify(th.body));
    assert.equal(th.body.thread.source.path, "main.tex");
    assert.match(th.body.thread.anchor.quote, /These results prove that\s+attention\s+is sufficient\./, "found in the PDF too");
    assert.equal(th.body.thread.anchor.page, 1);
  });
});

describe("paper without a server compiler", { skip: tectonic ? false : "tectonic not installed (needed to build the PDF the agent uploads)" }, () => {
  test("accepted edits wait for the agent's PDF", async () => {
    const env = await startApp({ compiler: "none" });
    try {
      const human = client(env.base, await login(env.base, "human", "Ada"));
      const agent = client(env.base, await login(env.base, "agent", "Scribe"));
      const compiler = createTectonicCompiler({ binary: tectonic!, timeoutMs: 60_000 });
      const build = async (files: Record<string, string>) => {
        const r = await compiler.compile(Object.entries(files).map(([p, c]) => ({ path: p, data: enc.encode(c) })), "main.tex");
        assert.ok(r.ok, r.log);
        return { pdf_base64: Buffer.from(r.pdf!).toString("base64"), synctex_base64: Buffer.from(r.synctex!).toString("base64") };
      };
      // Repeated phrase, PDF uploaded without SyncTeX: context picks the right one.
      const repeated = String.raw`\documentclass{article}\begin{document}
Our first experiment shows the model is robust to noise in the inputs.

A second ablation removes the router; again the model is robust to noise, which surprised us.
\end{document}
`;
      const { pdf_base64 } = await build({ "main.tex": repeated });
      const rep = await agent("POST", "/api/papers", { title: "Rep", files: [{ path: "main.tex", content: repeated }], pdf_base64 });
      const repDoc = (await human("GET", `/api/documents/${rep.body.id}`)).body;
      const at = repDoc.text.indexOf("the model is robust to noise", repDoc.text.indexOf("second"));
      const mapped = await human("POST", `/api/documents/${rep.body.id}/map`, { start: at, end: at + "the model is robust to noise".length });
      assert.equal(mapped.body.source.line, 4, "second occurrence (line 4), not the first (line 2)");

      const created = await agent("POST", "/api/papers", { title: "P3", files: [{ path: "main.tex", content: MAIN }, { path: "sections/method.tex", content: METHOD }], ...(await build({ "main.tex": MAIN, "sections/method.tex": METHOD })) });
      const id = created.body.id;
      const d1 = (await human("GET", `/api/documents/${id}`)).body;
      assert.equal(d1.paper.compile.status, "ok");
      const th = await agent("POST", `/api/documents/${id}/threads`, { quote: "twelve layers", body: "how many?", replacement: "24 layers" });
      const acc = await human("POST", `/api/suggestions/${th.body.thread.suggestions[0].id}/accept`, {});
      assert.equal(acc.status, 200);
      const d2 = (await human("GET", `/api/documents/${id}`)).body;
      assert.equal(d2.paper.compile.status, "needs_pdf");
      const newMethod = METHOD.replace("twelve layers", "24 layers");
      const up = await agent("POST", `/api/documents/${id}/pdf`, await build({ "main.tex": MAIN, "sections/method.tex": newMethod }));
      assert.equal(up.status, 200, JSON.stringify(up.body));
      const d3 = (await human("GET", `/api/documents/${id}`)).body;
      assert.equal(d3.paper.compile.status, "ok");
      assert.match(d3.text, /24 layers/);
      const t = d3.threads[0];
      assert.equal(d3.text.slice(t.anchor.start, t.anchor.end), "24 layers");
    } finally {
      env.close();
    }
  });
});
