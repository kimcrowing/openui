/* ==========================================================================
 * DOM rendering: keeps the UI in sync with application state. Deliberately
 * imperative and dependency-free — mutations go through state.subscribe().
 * ========================================================================== */

import { getState } from "./state.js";
import { buildMessage, makeStreamingTextNode, partRenderers } from "./messages.js";

const $ = (id) => document.getElementById(id);

let lastSessionsKey = "";
let lastBusy = null;

export function render(state) {
  renderTopbar(state);
  renderSessions(state);
  renderMessages(state);
  renderComposer(state);
}

/* ---------- Top bar ---------- */

function renderTopbar(state) {
  const title = $("topbar-title");
  const current = state.sessions.find((s) => s.id === state.currentSessionId);
  title.textContent = current && current.title ? current.title : "欢迎使用 OpenCode";

  const pill = $("server-pill");
  pill.className = state.connected ? "pill online" : "pill offline";
  pill.querySelector(".led");
  pill.lastChild.textContent = state.connected
    ? `已连接${state.health && state.health.version ? ` · v${state.health.version}` : ""}`
    : "未连接";
}

/* ---------- Session list ---------- */

function renderSessions(state) {
  const key = state.sessions
    .map((s) => `${s.id}|${s.title}|${s.time?.updated}`)
    .join("\u0001");
  const busyKey = `${state.currentSessionId}:${state.busy}`;
  if (key === lastSessionsKey && busyKey === lastBusy) return;

  lastSessionsKey = key;
  lastBusy = busyKey;

  const list = $("session-list");
  list.innerHTML = "";

  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.cssText = "padding:14px;text-align:center;font-size:12px;";
    empty.textContent = "暂无会话";
    list.appendChild(empty);
    return;
  }

  // Sort: busy current first, then by updated desc
  const sorted = [...state.sessions].sort((a, b) => {
    if (a.id === state.currentSessionId) return -1;
    if (b.id === state.currentSessionId) return 1;
    return (b.time?.updated || 0) - (a.time?.updated || 0);
  });

  for (const s of sorted) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === state.currentSessionId ? " active" : "");
    item.dataset.id = s.id;

    const dot = document.createElement("span");
    dot.className = "dot" + (s.id === state.currentSessionId && state.busy ? " busy" : "");
    item.appendChild(dot);

    const title = document.createElement("span");
    title.className = "s-title";
    title.textContent = s.title || "未命名会话";
    item.appendChild(title);

    const del = document.createElement("button");
    del.className = "icon-btn del";
    del.title = "删除会话";
    del.innerHTML = "&#128465;";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      onDeleteSession(s.id);
    });
    item.appendChild(del);

    item.addEventListener("click", () => onSelectSession(s.id));
    list.appendChild(item);
  }
}

/* ---------- Messages ---------- */

let messagesCache = { sessionId: null, key: "" };

// Set by app.js when the message list must be fully rebuilt (session switch,
// initial load). Streaming updates do NOT set this.
export function markMessagesDirty() {
  renderMessages._dirty = true;
}

function renderMessages(state) {
  const inner = $("messages-inner");
  const empty = $("empty-state");

  if (!state.currentSessionId) {
    inner.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }

  if (messagesCache.sessionId === state.currentSessionId && !renderMessages._dirty) {
    empty.classList.add("hidden");
    return;
  }

  messagesCache = { sessionId: state.currentSessionId };
  renderMessages._dirty = false;
  empty.classList.add("hidden");
  inner.innerHTML = "";

  if (!state.messages.length) {
    const p = document.createElement("div");
    p.className = "muted";
    p.style.cssText = "text-align:center;padding:40px;";
    p.textContent = "发送第一条消息开始对话";
    inner.appendChild(p);
    return;
  }

  for (const m of state.messages) {
    inner.appendChild(buildMessage(m.info, m.parts));
  }
  scrollBottom();
}

/* ---------- Composer ---------- */

function renderComposer(state) {
  const input = $("input");
  const send = $("send-btn");
  const hint = $("composer-hint");

  if (state.busy) {
    send.classList.add("stop");
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    send.title = "停止生成";
    hint.textContent = "正在生成… 点击停止";
  } else {
    send.classList.remove("stop");
    send.innerHTML =
      '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.4-7.5c.8-.4.8-1.5 0-1.9L3.4 3.6c-.7-.3-1.4.3-1.4 1.1v5.4c0 .6.4 1.1.9 1.2l10 1.7-10 1.7c-.5.1-.9.6-.9 1.2v5.4c0 .9.7 1.4 1.4 1.1z"/></svg>';
    send.title = "发送 (Enter)";
    hint.textContent = "Enter 发送 · Shift+Enter 换行";
  }

  if (state.prompt !== input.value) input.value = state.prompt;
}

/* ---------- Actions (injected from app.js) ---------- */

let actions = {};
export function setActions(a) {
  actions = a;
}

function onSelectSession(id) {
  if (actions.onSelectSession) actions.onSelectSession(id);
}
function onDeleteSession(id) {
  if (actions.onDeleteSession) actions.onDeleteSession(id);
}

export function scrollBottom() {
  const m = $("messages");
  requestAnimationFrame(() => {
    m.scrollTop = m.scrollHeight;
  });
}

/**
 * Appends a freshly received message to the DOM incrementally (used by SSE),
 * without full re-render. Returns a handle the event handler can update.
 */
export function appendMessageDOM(info, parts) {
  const inner = $("messages-inner");
  const el = buildMessage(info, parts || []);
  // hide empty-state
  $("empty-state").classList.add("hidden");
  inner.appendChild(el);
  scrollBottom();
  return el;
}

/**
 * Locates a part element by part id and updates it live during streaming.
 */
export function updatePartDOM(part) {
  const r = partRenderers[part.type];
  if (!r) return;
  // tool parts carry data-toolId on container
  let target = document.querySelector(`[data-tool-id="${CSS.escape(part.id)}"]`);
  if (target && target.parentNode) {
    const fresh = r(part);
    target.replaceWith(fresh);
  }
}
