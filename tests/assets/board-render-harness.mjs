// Render a built bearings board's shipped inline script under a minimal DOM
// shim and print what the renderer actually produced, so board behavior is
// asserted through the real template rather than by reading its source.
//
// Usage: node board-render-harness.mjs <built-board.html> [steps-json]
// `steps-json` is a JSON array of captain gestures replayed against the real
// handlers after the render, each one of:
//   {"op":"remove","id":"<task-id>"} click that row's "Remove from queue"
//   {"op":"undo","id":"<task-id>"}   click that row's "Undo"
//   {"op":"queue"}                   click "Queue removals"
// Prints one JSON document:
//   { stats:[{n,label}], underway:[{title,sub,badges}],
//     charted:[{title,sub,badges,pickable,facts,removable}],
//     groups:[{name,meta,rows}], empty, more, error,
//     queued:[{queueKey,question,answer,prompt}] }
import { readFileSync } from "node:fs";

const html = readFileSync(process.argv[2], "utf8");

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.className = "";
    this.children = [];
    this.attributes = {};
    this._text = "";
    this.hidden = false;
    this.disabled = false;
    this.innerHTML = "";
    this.parentNode = null;
    this.type = "";
    this.value = "";
    this.checked = false;
    this.classList = {
      add: (c) => { this.className = (this.className + " " + c).trim(); },
      remove: (c) => {
        this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(" ");
      },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  get textContent() {
    return this.children.length
      ? this.children.map((c) => c.textContent).join("")
      : this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
  setAttribute(k, v) { this.attributes[k] = v; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  addEventListener(type, fn) {
    (this._listeners ??= new Map()).set(type, (this._listeners.get(type) ?? []).concat(fn));
  }
  dispatch(type) {
    for (const fn of this._listeners?.get(type) ?? []) fn.call(this, { type, target: this });
  }
  querySelectorAll(sel) {
    const want = sel.replace(/^\./, "").replace(/:checked$/, "");
    const checkedOnly = sel.endsWith(":checked");
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.className.split(/\s+/).includes(want) && (!checkedOnly || c.checked)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

const byId = new Map();
const dataNode = new Node("script");
dataNode.textContent = html
  .split('<script id="bearings-data" type="application/json">')[1]
  .split("</script>")[0];
byId.set("bearings-data", dataNode);

globalThis.document = {
  createElement: (tag) => new Node(tag),
  // Lazily mint any element the page asks for: the shim tracks whatever ids
  // the shipped template actually uses instead of pinning a fixed list.
  getElementById: (id) => {
    if (!byId.has(id)) {
      const n = new Node("div");
      new Node("div").appendChild(n);
      byId.set(id, n);
    }
    return byId.get(id);
  },
  querySelector: (sel) => {
    const id = "sel:" + sel;
    if (!byId.has(id)) byId.set(id, new Node("div"));
    return byId.get(id);
  },
};
const queuedPrompts = [];
globalThis.window = {
  lavish: {
    queuePrompt(prompt, options) {
      const key = options?.queueKey ?? "";
      const entry = { prompt, options };
      const at = key ? queuedPrompts.findIndex((q) => (q.options?.queueKey ?? "") === key) : -1;
      if (at === -1) queuedPrompts.push(entry); else queuedPrompts[at] = entry;
    },
  },
};
globalThis.TextEncoder = TextEncoder;

const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
new Function(script)();

const badgesOf = (row) =>
  row.children
    .filter((c) => c.className.includes("fm-badge"))
    .map((c) => ({
      // fm-badge--sm is a size modifier; the tone is the other one.
      tone: (c.className.match(/fm-badge--(?!sm\b)([a-z]+)/) ?? [, ""])[1],
      text: c.textContent,
    }));

const strip = byId.get("bb-stats") || new Node("div");
const stats = strip.children.map((t) => ({
  n: Number(t.children.find((c) => c.className.includes("bb-stat__num"))?.textContent),
  label: t.children.find((c) => c.className.includes("bb-stat__label"))?.textContent,
}));

// Charted Next nests its rows inside collapsible project groups, and a row
// nests its own title inside a summary button, so both lookups walk
// descendants rather than direct children.
const descendants = (node, cls) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c.className.split(/\s+/).includes(cls)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
};
const firstWith = (node, cls) => descendants(node, cls)[0];

const rowOf = (row) => {
  const main = row.children.find((c) => c.className.includes("bb-row__main"));
  const panel = main ? firstWith(main, "bb-panel") : undefined;
  const factNodes = panel ? (firstWith(panel, "bb-panel__facts")?.children ?? []) : [];
  const facts = {};
  for (let i = 0; i + 1 < factNodes.length; i += 2) facts[factNodes[i].textContent] = factNodes[i + 1].textContent;
  return {
    title: main ? (firstWith(main, "bb-row__title")?.textContent ?? "") : "",
    sub: main ? (firstWith(main, "bb-row__sub")?.textContent ?? "") : "",
    badges: badgesOf(row),
    pickable: row.children.some((c) => c.className.includes("bb-pick") && !c.className.includes("spacer")),
    facts,
    removable: panel ? descendants(panel, "fm-btn").some((b) => b.textContent === "Remove from queue") : false,
  };
};

const rowsOf = (container) => descendants(container, "bb-row").map(rowOf);

const uw = byId.get("bb-underway") || new Node("div");
const underway = rowsOf(uw);

const ch = byId.get("bb-charted") || new Node("div");
const charted = rowsOf(ch);
const groups = descendants(ch, "bb-group").map((g) => {
  const head = g.children.find((c) => c.className.includes("bb-group__head"));
  const body = g.children.find((c) => c.className.includes("bb-group__body"));
  return {
    name: head ? (firstWith(head, "bb-eyebrow")?.textContent ?? "") : "",
    meta: head ? (firstWith(head, "bb-meta")?.textContent ?? "") : "",
    rows: body ? descendants(body, "bb-row").map((r) => firstWith(r, "bb-row__title")?.textContent ?? "") : [],
  };
});
// A fail-closed render replaces the page body instead of the board sections, so
// surface it rather than reporting an empty board as a successful render.
const errorText = [...byId.entries()]
  .filter(([k]) => k.startsWith("sel:"))
  .flatMap(([, n]) => n.children.map((c) => c.textContent))
  .join(" ");
const empty = descendants(ch, "bb-empty").map((c) => c.textContent);
const more = descendants(ch, "bb-morechip").map((c) => c.textContent);

// Replay the captain's gestures through the handlers the template actually
// registered, so what is asserted is the board's own behavior.
const rowNodeFor = (id) =>
  descendants(ch, "bb-row").find((r) => rowOf(r).facts["Task record"] === id);
const buttonIn = (node, cls, label) =>
  descendants(node, cls).find((b) => b.textContent === label);
const undoAfter = (row) => {
  const sibs = row.parentNode?.children ?? [];
  const next = sibs[sibs.indexOf(row) + 1];
  return next?.className.split(/\s+/).includes("bb-undo") ? next : undefined;
};
const clickOrDie = (node, what) => {
  if (!node) throw new Error("board-render-harness: no " + what);
  node.dispatch("click");
};

for (const step of JSON.parse(process.argv[3] ?? "[]")) {
  if (step.op === "queue") {
    clickOrDie(byId.get("bb-remove-btn"), "Queue removals button");
    continue;
  }
  const row = rowNodeFor(step.id);
  if (!row) throw new Error("board-render-harness: no charted row for " + step.id);
  if (step.op === "remove") {
    clickOrDie(buttonIn(row, "fm-btn", "Remove from queue"), "Remove button for " + step.id);
  } else if (step.op === "undo") {
    clickOrDie(buttonIn(undoAfter(row) ?? row, "bb-linkcta", "Undo"), "Undo button for " + step.id);
  } else {
    throw new Error("board-render-harness: unknown step " + step.op);
  }
}

const queued = queuedPrompts.map((q) => ({
  queueKey: q.options?.queueKey ?? "",
  question: q.options?.data?.question ?? "",
  answer: q.options?.data?.answer ?? "",
  prompt: q.prompt,
}));

process.stdout.write(
  JSON.stringify({ stats, underway, charted, groups, empty, more, error: errorText, queued }) + "\n");
