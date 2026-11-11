// Raft Review web client. No build step: plain ES modules + PDF.js from cdnjs.

const PDFJS_VERSION = "4.4.168";
const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;
const PAGE_SEP = "\f";

const state = {
  me: null,
  devLogin: false,
  serviceKey: "raft-review",
  docs: [],
  agents: [],
  doc: null,
  activeThread: null,
  filter: "open",
  composer: null, // { start, end, quote }
  preview: null, // suggestion id being previewed inline
  events: null,
  pdf: null, // { id, version, pages: [{ el, layer, hl, start, length }] }
};

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style") el.style.cssText = v;
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (res.status === 401 && state.me) {
    // Sessions last as long as the Raft access token (1 h); sign in again and
    // come back to the same document.
    location.href = `/auth/login?return_to=${encodeURIComponent(`/${location.hash}`)}`;
    return new Promise(() => {});
  }
  if (!res.ok) {
    const err = new Error(data?.message ?? data?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(ts).toLocaleDateString();
}

function avatar(user) {
  const initials = (user.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return h("div", { class: `avatar ${user.type === "agent" ? "agent" : ""}`, title: user.name },
    user.avatar_url ? h("img", { src: user.avatar_url, alt: "" }) : initials);
}

function who(user) {
  return [user.name, user.type === "agent" ? h("span", { class: "tag" }, "agent") : null];
}

function clip(text, n) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function isHuman() {
  return state.me?.type === "human";
}

function bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** Keep typed-but-unsent text across re-renders. */
function saveDrafts(root) {
  const drafts = {};
  root.querySelectorAll("[data-draft]").forEach((el) => { drafts[el.dataset.draft] = el.value; });
  const focused = document.activeElement?.dataset?.draft;
  const sel = focused ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  return () => {
    root.querySelectorAll("[data-draft]").forEach((el) => {
      if (drafts[el.dataset.draft] !== undefined) el.value = drafts[el.dataset.draft];
      if (el.dataset.draft === focused) {
        el.focus();
        if (sel) el.setSelectionRange(sel[0], sel[1]);
      }
    });
  };
}

// ---------- PDF.js ----------

let pdfjsPromise;
function pdfjs() {
  pdfjsPromise ??= import(`${PDFJS_BASE}/pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

/** Page text exactly as the text layer renders it: each item's string, plus a
 *  newline where the item ends a line. Anchors are offsets into this text. */
function pageTextFromContent(content) {
  return content.items.map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : "")).join("");
}

async function extractPdfText(bytes) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: bytes.slice() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    pages.push(pageTextFromContent(await page.getTextContent()));
  }
  return pages.join(PAGE_SEP);
}

const measureCtx = document.createElement("canvas").getContext("2d");

async function renderPdf(container, doc) {
  const lib = await pdfjs();
  const bytes = new Uint8Array(await (await fetch(`/api/documents/${doc.id}/raw?version=${doc.current_version}`)).arrayBuffer());
  const pdf = await lib.getDocument({ data: bytes }).promise;
  const pagesEl = h("div", { class: "pdf-pages" });
  container.replaceChildren(pagesEl);
  const width = Math.min(container.clientWidth - 48, 900);
  const pages = [];
  let offset = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const ratio = window.devicePixelRatio || 1;
    const canvas = h("canvas", { width: Math.floor(viewport.width * ratio), height: Math.floor(viewport.height * ratio), style: `width:${viewport.width}px;height:${viewport.height}px` });
    const hl = h("div", { class: "pdf-hl" });
    const layer = h("div", { class: "pdf-text", dataset: { page: String(i) } });
    const el = h("div", { class: "pdf-page", style: `width:${viewport.width}px;height:${viewport.height}px` }, canvas, hl, layer);
    pagesEl.append(el);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item.str) {
        const tx = lib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const style = content.styles[item.fontName] ?? {};
        const ascent = style.ascent ? style.ascent * fontHeight : style.descent ? (1 + style.descent) * fontHeight : fontHeight * 0.8;
        const angle = Math.atan2(tx[1], tx[0]);
        const span = h("span", {}, item.str);
        span.style.left = `${tx[4] + ascent * Math.sin(angle)}px`;
        span.style.top = `${tx[5] - ascent * Math.cos(angle)}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.fontFamily = style.fontFamily ?? "sans-serif";
        measureCtx.font = `${fontHeight}px ${style.fontFamily ?? "sans-serif"}`;
        const natural = measureCtx.measureText(item.str).width;
        const target = (style.vertical ? item.height : item.width) * viewport.scale;
        const scaleX = natural > 0 && target > 0 ? target / natural : 1;
        span.style.transform = `${angle ? `rotate(${angle}rad) ` : ""}scaleX(${scaleX})`;
        layer.append(span);
      }
      if (item.hasEOL) layer.append(document.createTextNode("\n"));
    }
    const length = pageTextFromContent(content).length;
    pages.push({ el, layer, hl, start: offset, length });
    offset += length + PAGE_SEP.length;
  }
  state.pdf = { id: doc.id, version: doc.current_version, pages };
  paintPdfHighlights();
}

/** Text node + local offset for a character offset within a container. */
function locate(container, offset) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentElement?.closest("[data-skip]")) continue;
    const len = node.nodeValue.length;
    if (offset <= seen + len) return { node, offset: offset - seen };
    seen += len;
    last = node;
  }
  return last ? { node: last, offset: last.nodeValue.length } : null;
}

function paintPdfHighlights() {
  if (!state.pdf || !state.doc) return;
  for (const page of state.pdf.pages) page.hl.replaceChildren();
  for (const t of visibleThreads()) {
    const hasSuggestion = t.suggestions.some((s) => s.status === "pending");
    for (const page of state.pdf.pages) {
      const from = Math.max(t.anchor.start, page.start) - page.start;
      const to = Math.min(t.anchor.end, page.start + page.length) - page.start;
      if (to <= from) continue;
      const a = locate(page.layer, from);
      const b = locate(page.layer, to);
      if (!a || !b) continue;
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const box = page.el.getBoundingClientRect();
      for (const r of range.getClientRects()) {
        if (r.width < 1) continue;
        const div = h("div", {
          class: `${hasSuggestion ? "sugg" : ""} ${state.activeThread === t.id ? "active" : ""}`,
          style: `left:${r.left - box.left}px;top:${r.top - box.top}px;width:${r.width}px;height:${r.height}px`,
        });
        page.hl.append(div);
      }
    }
  }
}

// ---------- selection → offsets ----------

function textOffset(container, node, offset) {
  const range = document.createRange();
  range.setStart(container, 0);
  range.setEnd(node, offset);
  const frag = range.cloneContents();
  frag.querySelectorAll("[data-skip]").forEach((el) => el.remove());
  return frag.textContent.length;
}

function selectionAnchor() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const doc = state.doc;
  if (!doc) return null;
  let start;
  let end;
  if (doc.kind === "pdf") {
    const layerOf = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest(".pdf-text");
    const la = layerOf(range.startContainer);
    const lb = layerOf(range.endContainer);
    if (!la || !lb || !state.pdf) return null;
    const pa = state.pdf.pages[Number(la.dataset.page) - 1];
    const pb = state.pdf.pages[Number(lb.dataset.page) - 1];
    start = pa.start + textOffset(la, range.startContainer, range.startOffset);
    end = pb.start + textOffset(lb, range.endContainer, range.endOffset);
  } else {
    const container = document.querySelector(".doc-text");
    if (!container || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
    start = textOffset(container, range.startContainer, range.startOffset);
    end = textOffset(container, range.endContainer, range.endOffset);
  }
  // Trim surrounding whitespace so anchors hug the words.
  const text = doc.text;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (end <= start) return null;
  return { start, end, quote: text.slice(start, end), rect: range.getBoundingClientRect() };
}

// ---------- routing ----------

window.addEventListener("hashchange", route);

async function route() {
  const match = location.hash.match(/^#\/doc\/([^/]+)/);
  if (state.events && (!match || match[1] !== state.doc?.id)) {
    state.events.close();
    state.events = null;
  }
  if (!state.me) return renderSignIn();
  if (match) return openDocument(match[1]);
  state.doc = null;
  state.pdf = null;
  return renderLibrary();
}

async function boot() {
  const me = await api("GET", "/api/me");
  state.me = me.user;
  state.devLogin = me.dev_login;
  state.serviceKey = me.service_key;
  renderUserChip();
  route();
}

function renderUserChip() {
  const el = document.getElementById("topbar-user");
  if (!state.me) return el.replaceChildren();
  el.replaceChildren(
    h("span", { class: "small muted" }, ...who(state.me)),
    avatar(state.me),
    h("button", {
      class: "btn small ghost",
      onclick: async () => { await api("POST", "/auth/logout"); location.hash = "#/"; location.reload(); },
    }, "Sign out"),
  );
}

// ---------- sign-in ----------

function renderSignIn() {
  document.getElementById("topbar-doc").replaceChildren();
  const app = document.getElementById("app");
  const name = h("input", { placeholder: "Your name", value: "Dev Human", "aria-label": "Name" });
  app.replaceChildren(h("div", { class: "signin" },
    h("h1", {}, "Review documents with your agents"),
    h("p", {}, "Highlight a passage, leave a comment, and your Raft agent replies in the thread with edits you accept or reject."),
    h("a", { class: "btn primary", href: "/auth/login" }, "Sign in with Raft"),
    state.devLogin ? h("div", { style: "margin-top:24px" },
      h("div", { class: "small muted" }, "Local development: sign in without Raft"),
      h("div", { class: "row" }, name,
        h("button", { class: "btn", onclick: () => devLogin("human", name.value) }, "As human"),
        h("button", { class: "btn", onclick: () => devLogin("agent", name.value || "Reviewer Bot") }, "As agent")),
    ) : null,
  ));
}

async function devLogin(type, name) {
  await api("POST", "/auth/dev-login", { type, name });
  await boot();
}

// ---------- library ----------

async function renderLibrary() {
  document.getElementById("topbar-doc").replaceChildren();
  const app = document.getElementById("app");
  const [{ documents }, { agents }] = await Promise.all([api("GET", "/api/documents"), api("GET", "/api/agents")]);
  state.docs = documents;
  state.agents = agents;

  const fileInput = h("input", { type: "file", accept: ".md,.markdown,.txt,.tex,.latex,.bib,.pdf,text/*,application/pdf", hidden: true });
  const reviewer = reviewerSelect(null);
  const drop = h("div", { class: "dropzone" },
    h("div", {}, "Drop a document here — Markdown, LaTeX, plain text or PDF"),
    h("div", { class: "row" },
      h("button", { class: "btn primary", onclick: () => fileInput.click() }, "Upload document"),
      h("label", { class: "small muted" }, "Reviewer ", reviewer)),
    fileInput);
  const upload = async (file) => {
    if (!file) return;
    try {
      const body = { filename: file.name, title: file.name.replace(/\.[^.]+$/, ""), reviewer_agent_id: reviewer.value || undefined };
      if (/\.pdf$/i.test(file.name)) {
        toast("Reading PDF…");
        const bytes = new Uint8Array(await file.arrayBuffer());
        body.text = await extractPdfText(bytes);
        body.file_base64 = bytesToBase64(bytes);
      } else {
        body.text = await file.text();
      }
      const doc = await api("POST", "/api/documents", body);
      location.hash = `#/doc/${doc.id}`;
    } catch (err) {
      toast(`Upload failed: ${err.message}`);
    }
  };
  fileInput.addEventListener("change", () => upload(fileInput.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); upload(e.dataTransfer.files[0]); });

  const list = documents.length
    ? h("div", { class: "doc-list" }, documents.map((d) => h("a", { class: "doc-row", href: `#/doc/${d.id}` },
      h("span", { class: "kind" }, d.kind === "markdown" ? "md" : d.kind === "latex" ? "tex" : d.kind === "pdf" ? "pdf" : "txt"),
      h("div", {}, h("div", { class: "name" }, d.title), h("div", { class: "small muted" }, `${d.filename} · v${d.current_version} · updated ${ago(d.updated_at)}`)),
      h("div", { style: "display:flex;gap:6px;flex-wrap:wrap;justify-content:end" },
        d.pending_suggestions ? h("span", { class: "pill agent" }, `${d.pending_suggestions} suggestion${d.pending_suggestions > 1 ? "s" : ""}`) : null,
        d.open_threads ? h("span", { class: "pill warn" }, `${d.open_threads} open`) : h("span", { class: "pill" }, "no open threads")))))
    : h("div", { class: "empty" }, "No documents yet. Upload one, or ask an agent to publish its draft with ", h("code", {}, "upload_document"), ".");

  app.replaceChildren(
    h("div", { class: "library-head" }, h("h1", {}, "Documents"), h("span", { class: "small muted" }, `${agents.length} agent${agents.length === 1 ? "" : "s"} connected`)),
    isHuman() ? drop : null,
    list,
    agentHelp(),
  );
}

function reviewerSelect(current, onChange) {
  const select = h("select", { "aria-label": "Reviewer agent", onchange: onChange ? (e) => onChange(e.target.value) : null },
    h("option", { value: "" }, state.agents.length ? "No reviewer" : "No agents connected yet"),
    state.agents.map((a) => h("option", { value: a.id, selected: a.id === current }, `@${a.username}`)));
  return select;
}

function agentHelp() {
  const svc = state.serviceKey;
  return h("div", { class: "help" },
    h("h3", {}, "Connect an agent"),
    h("div", {}, "Ask an agent in Raft to run ", h("code", {}, `raft integration login --service ${svc}`),
      ". It then shows up as a reviewer here and is woken through its Raft inbox whenever you comment. Agents work with ",
      h("code", {}, `raft integration invoke --service ${svc} --list-actions`), "."));
}

// ---------- document ----------

async function openDocument(id) {
  try {
    const [doc, { agents }] = await Promise.all([api("GET", `/api/documents/${id}`), api("GET", "/api/agents")]);
    state.agents = agents;
    const changedVersion = !state.doc || state.doc.id !== doc.id || state.doc.current_version !== doc.current_version;
    state.doc = doc;
    if (changedVersion) state.composer = null;
    renderDocument(changedVersion);
    if (!state.events) {
      state.events = new EventSource(`/api/documents/${id}/events`);
      let timer;
      state.events.addEventListener("change", () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 150);
      });
    }
  } catch (err) {
    document.getElementById("app").replaceChildren(h("div", { class: "empty" }, `Could not open document: ${err.message}. `, h("a", { href: "#/" }, "Back")));
  }
}

async function refresh() {
  if (!state.doc) return;
  const doc = await api("GET", `/api/documents/${state.doc.id}`);
  const changedVersion = doc.current_version !== state.doc.current_version;
  state.doc = doc;
  renderDocument(changedVersion);
}

function visibleThreads() {
  return state.doc.threads.filter((t) => t.status !== "orphaned" && (state.filter === "all" || t.status === "open"));
}

function renderDocument(rebuildPaper = true) {
  const doc = state.doc;
  renderDocTopbar();
  const app = document.getElementById("app");
  let layout = app.querySelector(".review");
  if (!layout || layout.dataset.doc !== doc.id) {
    layout = h("div", { class: "review", dataset: { doc: doc.id } },
      h("div", { class: `paper ${doc.kind === "pdf" ? "pdf" : ""}` }),
      h("aside", { class: "sidebar" }));
    app.replaceChildren(layout, h("button", { class: "add-comment", onmousedown: (e) => e.preventDefault(), onclick: startComposer }, "💬 Comment"));
    rebuildPaper = true;
  }
  const paper = layout.querySelector(".paper");
  if (doc.kind === "pdf") {
    if (rebuildPaper || !state.pdf || state.pdf.id !== doc.id || state.pdf.version !== doc.current_version) {
      paper.replaceChildren(h("div", { class: "muted" }, "Rendering PDF…"));
      renderPdf(paper, doc).catch((err) => paper.replaceChildren(h("div", { class: "empty" }, `PDF failed to render: ${err.message}`)));
    } else {
      paintPdfHighlights();
    }
  } else {
    renderText(paper);
  }
  renderSidebar(layout.querySelector(".sidebar"));
}

function renderDocTopbar() {
  const doc = state.doc;
  const el = document.getElementById("topbar-doc");
  const versionInput = h("input", { type: "file", hidden: true, accept: doc.kind === "pdf" ? ".pdf,application/pdf" : ".md,.markdown,.txt,.tex,.latex,.bib,text/*" });
  versionInput.addEventListener("change", async () => {
    const file = versionInput.files[0];
    if (!file) return;
    try {
      const body = { note: `Uploaded ${file.name}` };
      if (doc.kind === "pdf") {
        const bytes = new Uint8Array(await file.arrayBuffer());
        body.text = await extractPdfText(bytes);
        body.file_base64 = bytesToBase64(bytes);
      } else body.text = await file.text();
      await api("POST", `/api/documents/${doc.id}/versions`, body);
      toast("New version uploaded; threads re-anchored");
      refresh();
    } catch (err) {
      toast(err.message);
    }
  });
  el.replaceChildren(
    h("a", { class: "btn small ghost", href: "#/" }, "←"),
    h("span", { class: "title" }, doc.title),
    h("span", { class: "pill", title: doc.versions[0]?.note }, `v${doc.current_version}`),
    isHuman()
      ? h("label", { class: "small muted" }, "Reviewer ", reviewerSelect(doc.reviewer?.id ?? null, async (agentId) => {
        await api("PATCH", `/api/documents/${doc.id}`, { reviewer_agent_id: agentId || null });
        toast(agentId ? "Reviewer set — the agent was notified" : "Reviewer removed");
        refresh();
      }))
      : null,
    h("a", { class: "btn small", href: `/api/documents/${doc.id}/raw`, download: doc.filename }, "Download"),
    isHuman() ? h("button", { class: "btn small", onclick: () => versionInput.click() }, "New version") : null,
    versionInput,
  );
}

function renderText(paper) {
  const doc = state.doc;
  const text = doc.text;
  const threads = visibleThreads();
  const preview = state.preview
    ? doc.threads.flatMap((t) => t.suggestions).find((s) => s.id === state.preview && s.status === "pending")
    : null;

  // Split the text at every anchor boundary so overlapping threads nest.
  const cuts = new Set([0, text.length]);
  for (const t of threads) { cuts.add(t.anchor.start); cuts.add(t.anchor.end); }
  if (preview) { cuts.add(preview.start); cuts.add(preview.end); }
  const points = [...cuts].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);

  const container = h("div", { class: `doc-text ${doc.kind === "latex" || doc.kind === "text" ? "mono" : ""}` });
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const seg = text.slice(a, b);
    const covering = threads.filter((t) => t.anchor.start <= a && t.anchor.end >= b);
    const inPreview = preview && preview.start <= a && preview.end >= b;
    if (preview && a === preview.start && preview.start === preview.end) {
      container.append(h("span", { class: "preview-ins", dataset: { skip: "1" } }, preview.replacement));
    }
    if (!covering.length && !inPreview) {
      container.append(seg);
    } else {
      const ids = covering.map((t) => t.id);
      const mark = h("mark", {
        class: [
          covering.some((t) => t.suggestions.some((s) => s.status === "pending")) ? "has-suggestion" : "",
          ids.includes(state.activeThread) ? "active" : "",
          inPreview ? "preview-del" : "",
        ].join(" "),
        dataset: { threads: ids.join(" ") },
        onclick: () => { if (ids.length) activate(ids[ids.length - 1], { scrollSidebar: true }); },
      }, seg);
      container.append(mark);
    }
    if (preview && b === preview.end && preview.start !== preview.end) {
      container.append(h("span", { class: "preview-ins", dataset: { skip: "1" } }, preview.replacement));
    }
  }
  paper.classList.toggle("preview", Boolean(preview));
  paper.replaceChildren(container);
}

function activate(threadId, { scrollSidebar = false, scrollDoc = false } = {}) {
  state.activeThread = threadId;
  document.querySelectorAll(".thread").forEach((el) => el.classList.toggle("active", el.dataset.id === threadId));
  document.querySelectorAll(".doc-text mark").forEach((el) => el.classList.toggle("active", el.dataset.threads.split(" ").includes(threadId)));
  if (state.doc?.kind === "pdf") paintPdfHighlights();
  if (scrollSidebar) document.querySelector(`.thread[data-id="${threadId}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  if (scrollDoc) {
    const target = document.querySelector(`.doc-text mark[data-threads~="${threadId}"]`) ?? document.querySelector(".pdf-hl div.active");
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// ---------- selection affordance ----------

document.addEventListener("selectionchange", () => {
  const btn = document.querySelector(".add-comment");
  if (!btn || !state.doc) return;
  const anchor = selectionAnchor();
  if (!anchor) { btn.style.display = "none"; return; }
  btn.style.display = "block";
  btn.style.left = `${anchor.rect.left + anchor.rect.width / 2 + window.scrollX}px`;
  btn.style.top = `${anchor.rect.top + window.scrollY - 8}px`;
});

function startComposer() {
  const anchor = selectionAnchor();
  if (!anchor) return;
  state.composer = { start: anchor.start, end: anchor.end, quote: anchor.quote };
  document.querySelector(".add-comment").style.display = "none";
  window.getSelection()?.removeAllRanges();
  renderSidebar(document.querySelector(".sidebar"));
  document.querySelector(".composer textarea")?.focus();
}

// ---------- sidebar ----------

function renderSidebar(sidebar) {
  const restore = saveDrafts(sidebar);
  const doc = state.doc;
  const threads = doc.threads.filter((t) => state.filter === "all" || t.status === "open");
  const counts = { open: doc.threads.filter((t) => t.status === "open").length, all: doc.threads.length };

  const children = [];
  if (!doc.reviewer && isHuman()) {
    children.push(h("div", { class: "banner" },
      state.agents.length ? "Pick a reviewer agent in the top bar so it is woken when you comment." : ["No agent connected yet. In Raft, ask one to run ", h("code", {}, `raft integration login --service ${state.serviceKey}`), "."]));
  } else if (doc.reviewer) {
    children.push(h("div", { class: "small muted" }, "Reviewer: ", ...who(doc.reviewer), " — woken in Raft on every comment"));
  }
  if (doc.kind === "pdf") {
    const accepted = doc.threads.flatMap((t) => t.suggestions.filter((s) => s.status === "accepted"));
    if (accepted.length) {
      const checklist = accepted.map((s) => `- [ ] Replace “${clip(s.original, 120)}” with “${clip(s.replacement, 200)}”`).join("\n");
      children.push(h("div", { class: "banner" },
        `${accepted.length} accepted change${accepted.length > 1 ? "s" : ""} to apply in the source. `,
        h("button", { class: "btn small", onclick: () => navigator.clipboard.writeText(checklist).then(() => toast("Checklist copied")) }, "Copy checklist")));
    }
  }
  children.push(h("div", { class: "sidebar-head" },
    h("h2", {}, "Comments"),
    h("div", { class: "filters" },
      ["open", "all"].map((f) => h("button", {
        class: state.filter === f ? "on" : "",
        onclick: () => { state.filter = f; renderDocument(false); },
      }, `${f === "open" ? "Open" : "All"} ${counts[f]}`)))));
  if (state.composer) children.push(composerCard());
  if (!threads.length && !state.composer) {
    children.push(h("div", { class: "empty small" }, "Select text in the document to start a comment."));
  }
  for (const t of threads) children.push(threadCard(t));
  sidebar.replaceChildren(...children);
  restore();
}

function composerCard() {
  const c = state.composer;
  const body = h("textarea", { placeholder: state.doc.reviewer ? `Comment — @${state.doc.reviewer.username} will reply` : "Comment", dataset: { draft: "composer" } });
  const suggestToggle = h("input", { type: "checkbox" });
  const replacement = h("textarea", { hidden: true, dataset: { draft: "composer-repl" } }, c.quote);
  suggestToggle.addEventListener("change", () => { replacement.hidden = !suggestToggle.checked; if (suggestToggle.checked) replacement.focus(); });
  const submit = async () => {
    if (!body.value.trim()) return body.focus();
    try {
      const res = await api("POST", `/api/documents/${state.doc.id}/threads`, {
        start: c.start, end: c.end, quote: c.quote, body: body.value,
        ...(suggestToggle.checked ? { replacement: replacement.value } : {}),
      });
      body.value = "";
      state.composer = null;
      state.activeThread = res.thread.id;
      await refresh();
    } catch (err) {
      toast(err.message);
      if (err.code === "anchor_moved") { state.composer = null; refresh(); }
    }
  };
  body.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); });
  return h("div", { class: "composer" },
    h("div", { class: "quote" }, c.quote),
    body,
    h("label", {}, suggestToggle, "Suggest a replacement"),
    replacement,
    h("div", { class: "row" },
      h("span", { class: "small muted" }, "⌘↵ to send"),
      h("div", { style: "display:flex;gap:6px" },
        h("button", { class: "btn small", onclick: () => { state.composer = null; renderDocument(false); } }, "Cancel"),
        h("button", { class: "btn small primary", onclick: submit }, "Comment"))));
}

function threadCard(t) {
  const doc = state.doc;
  const where = t.anchor.page ? `Page ${t.anchor.page}` : `Line ${t.anchor.line}`;
  const reply = h("textarea", { placeholder: "Reply…", rows: 2, dataset: { draft: `reply-${t.id}` } });
  const send = async () => {
    if (!reply.value.trim()) return;
    try {
      await api("POST", `/api/threads/${t.id}/comments`, { body: reply.value });
      reply.value = "";
      await refresh();
    } catch (err) { toast(err.message); }
  };
  reply.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); });

  const lastAuthorHuman = mergeTimeline(t).at(-1)?.value.author.type === "human";
  const awaiting = t.status === "open" && lastAuthorHuman && doc.reviewer;

  return h("div", {
    class: `thread ${t.status} ${state.activeThread === t.id ? "active" : ""}`,
    dataset: { id: t.id },
    onclick: (e) => { if (!e.target.closest("button, textarea, a")) activate(t.id, { scrollDoc: true }); },
  },
  h("div", { class: "loc" },
    h("span", {}, where),
    t.status !== "open" ? h("span", { class: "pill" }, t.status) : null,
    t.reanchored ? h("span", { class: "pill warn", title: "The passage was edited in a newer version; this comment moved with it." }, "text edited") : null,
    awaiting ? h("span", { class: "pill agent" }, `waiting on @${doc.reviewer.username}`) : null,
    h("span", { style: "flex:1" }),
    t.status === "open"
      ? h("button", { class: "btn small ghost", title: "Resolve", onclick: () => api("POST", `/api/threads/${t.id}/resolve`).then(refresh) }, "✓ Resolve")
      : t.status === "resolved" ? h("button", { class: "btn small ghost", onclick: () => api("POST", `/api/threads/${t.id}/reopen`).then(refresh) }, "Reopen") : null),
  h("div", { class: "quote", title: t.anchor.quote }, t.anchor.quote),
  mergeTimeline(t).map((item) => item.kind === "comment" ? commentView(item.value) : suggestionView(item.value)),
  t.status !== "orphaned" ? h("div", { class: "reply" }, reply,
    h("div", { class: "row" },
      h("span", {}),
      h("button", { class: "btn small primary", onclick: send }, "Reply"))) : h("div", { class: "small muted" }, "The highlighted text no longer exists in the current version."),
  );
}

function mergeTimeline(t) {
  return [
    ...t.comments.map((c) => ({ kind: "comment", at: c.created_at, value: c })),
    ...t.suggestions.map((s) => ({ kind: "suggestion", at: s.created_at, value: s })),
  ].sort((a, b) => a.at - b.at);
}

function commentView(c) {
  return h("div", { class: "comment" }, avatar(c.author),
    h("div", {},
      h("div", { class: "who" }, ...who(c.author), h("span", { class: "when" }, ago(c.created_at))),
      h("div", { class: "body" }, c.body)));
}

function suggestionView(s) {
  const pending = s.status === "pending";
  const decide = async (decision) => {
    try {
      await api("POST", `/api/suggestions/${s.id}/${decision}`, {});
      state.preview = null;
      toast(decision === "accept" ? (state.doc.kind === "pdf" ? "Accepted — added to the source checklist" : "Accepted — document updated") : "Rejected");
      await refresh();
    } catch (err) { toast(err.message); refresh(); }
  };
  const el = h("div", { class: "suggestion" },
    h("div", { class: "s-head" },
      h("span", { style: "display:flex;gap:6px;align-items:center" }, avatar(s.author), h("strong", {}, ...who(s.author)), " suggested"),
      h("span", { class: `status ${s.status}` }, s.status)),
    h("div", { class: "diff" },
      s.original ? h("del", {}, s.original) : null,
      s.original && s.replacement ? " " : null,
      s.replacement ? h("ins", {}, s.replacement) : h("span", { class: "muted small" }, " (delete)")),
    s.rationale ? h("div", { class: "rationale" }, s.rationale) : null,
    pending && isHuman() ? h("div", { class: "actions" },
      h("button", { class: "btn small accept", onclick: () => decide("accept") }, "✓ Accept"),
      h("button", { class: "btn small reject", onclick: () => decide("reject") }, "✕ Reject")) : null,
    s.decided_by ? h("div", { class: "rationale" }, `${s.status} by ${s.decided_by.name} ${ago(s.decided_at)}`) : null);
  if (pending && state.doc.kind !== "pdf") {
    el.addEventListener("mouseenter", () => { state.preview = s.id; renderText(document.querySelector(".paper")); });
    el.addEventListener("mouseleave", () => { state.preview = null; renderText(document.querySelector(".paper")); });
  }
  return el;
}

boot().catch((err) => {
  document.getElementById("app").replaceChildren(h("div", { class: "empty" }, `Failed to load: ${err.message}`));
});
