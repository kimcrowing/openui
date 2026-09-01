/* ==========================================================================
 * Renders opencode messages and parts into DOM nodes.
 *
 * A "message" from GET /session/:id/message is { info: Message, parts: Part[] }.
 * Parts are typed: text, reasoning, tool, step-start, step-finish, file,
 * agent, retry, compaction, snapshot, patch, subtask.
 * ========================================================================== */

import { renderMarkdown } from "./markdown.js";

const ICONS = {
  bash: "❯",
  edit: "✎",
  webfetch: "⤓",
  read: "📄",
  glob: "🔍",
  grep: "🔎",
  write: "✎",
  task: "🧩",
  todowrite: "☑",
  question: "?",
  default: "⚙",
};

function toolIcon(tool) {
  for (const [k, v] of Object.entries(ICONS)) {
    if (tool && tool.includes(k)) return v;
  }
  return ICONS.default;
}

function timeStr(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toolStateLabel(s) {
  if (!s) return "pending";
  return s.status || "pending";
}

/* ---------- Part renderers (return a DOM element) ---------- */

function renderTextPart(part) {
  const wrap = document.createElement("div");
  wrap.className = "msg-text";
  wrap.innerHTML = renderMarkdown(part.text || "");
  return wrap;
}

function renderReasoningPart(part) {
  const el = document.createElement("details");
  el.className = "reasoning";
  const sum = document.createElement("summary");
  sum.textContent = "思考过程";
  el.appendChild(sum);
  const body = document.createElement("div");
  body.className = "msg-text muted";
  body.innerHTML = renderMarkdown(part.text || "");
  el.appendChild(body);
  return el;
}

function renderToolInputEl(props) {
  const el = document.createElement("div");
  el.className = "tool-body input";
  try {
    el.textContent = typeof props === "string" ? props : JSON.stringify(props, null, 2);
  } catch {
    el.textContent = String(props);
  }
  return el;
}

function renderToolPart(part) {
  const state = part.state || {};
  const container = document.createElement("div");
  container.className = "tool";
  container.dataset.toolId = part.id;

  const details = document.createElement("details");
  details.className = "tool-card";
  details.id = `tool-${part.id}`;

  const summary = document.createElement("summary");
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = "▶";
  const ic = document.createElement("span");
  ic.textContent = toolIcon(part.tool);
  ic.style.marginRight = "2px";
  const name = document.createElement("span");
  name.className = "t-name";
  name.textContent = part.tool || "tool";
  const badge = document.createElement("span");
  badge.className = `badge ${toolStateLabel(state)}`;
  badge.textContent = toolStateLabel(state);
  summary.append(caret, ic, name, badge);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "tool-body";

  if (state.status === "running" || state.status === "pending") {
    const spin = document.createElement("span");
    spin.className = "typing-spinner";
    body.textContent = state.title || "正在运行…";
    body.classList.add("tool-body");
    body.appendChild(spin);
  } else if (state.status === "error") {
    body.textContent = state.error || "执行出错";
    details.classList.add("error");
  } else if (state.status === "completed") {
    const out = state.output || "";
    if (out) body.textContent = out;
    else body.textContent = "(无输出)";
  } else {
    body.textContent = state.title || "";
  }

  details.appendChild(body);
  container.appendChild(details);

  // Show input in a nested collapsible
  if (state.input && Object.keys(state.input).length) {
    const inputWrap = document.createElement("details");
    inputWrap.className = "tool-card";
    inputWrap.style.marginTop = "4px";
    const isum = document.createElement("summary");
    const caret2 = document.createElement("span");
    caret2.className = "caret";
    caret2.textContent = "▶";
    const lbl = document.createElement("span");
    lbl.className = "t-name";
    lbl.textContent = "入参";
    isum.append(caret2, lbl);
    inputWrap.appendChild(isum);
    inputWrap.appendChild(renderToolInputEl(state.input));
    container.appendChild(inputWrap);
  }

  return container;
}

function renderStepPart(part) {
  const el = document.createElement("div");
  el.className = "step-pill";
  if (part.type === "step-start") {
    const ic = document.createElement("span");
    ic.textContent = "⏱";
    const t = document.createElement("span");
    const ms = part.time ? part.time.start : null;
    t.textContent = ms ? `思考 · ${timeStr(ms)}` : "思考";
    el.append(ic, t);
  } else if (part.type === "step-finish") {
    const ic = document.createElement("span");
    ic.textContent = "✓";
    const reason = part.reason && part.reason !== "done" ? ` · ${part.reason}` : "";
    const cost = part.cost ? ` · $${part.cost.toFixed(4)}` : "";
    const t = document.createElement("span");
    t.textContent = `完成${reason}${cost}`;
    el.append(ic, t);
  }
  return el;
}

function renderAgentPart(part) {
  const el = document.createElement("div");
  el.className = "step-pill";
  const ic = document.createElement("span");
  ic.textContent = "◆";
  const t = document.createElement("span");
  t.textContent = `子代理：${part.name}`;
  el.append(ic, t);
  return el;
}

function renderFilePart(part) {
  const el = document.createElement("div");
  el.className = "step-pill";
  const name = part.filename || part.url || "文件";
  const link = document.createElement("a");
  link.href = part.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = `📎 ${name}`;
  el.appendChild(link);
  return el;
}

function renderCompactionPart(part) {
  const el = document.createElement("div");
  el.className = "step-pill";
  el.textContent = part.auto ? "↺ 自动摘要" : "↺ 手动摘要";
  return el;
}

function renderRetryPart(part) {
  const el = document.createElement("div");
  el.className = "step-pill";
  el.textContent = `↻ 重试 #${part.attempt}`;
  return el;
}

function renderErrorPart(msg) {
  const el = document.createElement("div");
  el.className = "step-pill";
  el.style.color = "var(--danger)";
  const err = msg.error || msg.message || msg.data?.message || "发生错误";
  el.textContent = `✖ ${typeof err === "string" ? err : JSON.stringify(err)}`;
  return el;
}

export const partRenderers = {
  text: renderTextPart,
  reasoning: renderReasoningPart,
  tool: renderToolPart,
  "step-start": renderStepPart,
  "step-finish": renderStepPart,
  agent: renderAgentPart,
  file: renderFilePart,
  compaction: renderCompactionPart,
  retry: renderRetryPart,
};

/**
 * Builds the full DOM for a single message { info, parts }.
 * Returns the container element with class "message-row".
 */
export function buildMessage(info, parts, { compact = false } = {}) {
  const role = info.role || "assistant";
  const row = document.createElement("div");
  row.className = `message-row ${role}`;
  row.dataset.messageId = info.id;

  // Avatar
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (role === "user") {
    avatar.textContent = "我";
  } else {
    avatar.textContent = "A";
  }
  row.appendChild(avatar);

  // Body
  const body = document.createElement("div");
  body.className = "message-body";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = role === "user" ? "你" : info.mode || "opencode";
  meta.appendChild(name);

  const modelLabel = role === "assistant" && info.modelID ? `${info.providerID}/${info.modelID}` : "";
  if (modelLabel) {
    const m = document.createElement("span");
    m.className = "model";
    m.textContent = modelLabel;
    meta.appendChild(m);
  }
  if (info.time?.created) {
    const t = document.createElement("span");
    t.textContent = timeStr(info.time.created);
    meta.appendChild(t);
  }
  body.appendChild(meta);

  // Error banner
  if (info.error) body.appendChild(renderErrorPart(info));

  // Parts
  if (parts && parts.length) {
    const shown = new Set();
    for (const part of parts) {
      // collapse repeated step-start noise into one
      if (part.type === "step-start" && shown.has("step")) continue;
      shown.add("step");
      const r = partRenderers[part.type];
      if (r) {
        const el = r(part);
        if (el) body.appendChild(el);
      }
    }
  } else {
    const empty = document.createElement("div");
    empty.textContent = "…";
    empty.className = "muted";
    body.appendChild(empty);
  }

  row.appendChild(body);
  return row;
}

/** Renders streaming delta text into an inline text part node. */
export function makeStreamingTextNode() {
  const wrap = document.createElement("div");
  wrap.className = "msg-text";
  const p = document.createElement("p");
  wrap.appendChild(p);
  return { wrap, p };
}
