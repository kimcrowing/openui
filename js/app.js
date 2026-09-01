/* ==========================================================================
 * OpenCode Web — application entry point.
 *
 * Wires the static UI to an `opencode serve` server: session management,
 * REST calls, SSE real-time events, streaming message rendering, and the
 * settings / theme modals.
 * ========================================================================== */

import { OpenCodeClient } from "./api.js";
import { setState, getState, subscribe } from "./state.js";
import {
  render,
  setActions,
  scrollBottom,
  markMessagesDirty,
  updatePartDOM,
} from "./render.js";
import { setTheme, getTheme, THEMES } from "./themes.js";
import { makeStreamingTextNode } from "./messages.js";

const $ = (id) => document.getElementById(id);
const MODE_KEY = "opencode-web.mode"; // 'serve' | 'async'

/* --------------------------------------------------------------------------
 * Client / connection
 * -------------------------------------------------------------------------- */

let client = null;
let es = null;
let reconnectTimer = null;
const reconnectDelay = 3000;

const defaultConfig = {
  baseUrl: "http://127.0.0.1:4096",
  username: "opencode",
  password: "",
};

function loadConfig() {
  try {
    return { ...defaultConfig, ...JSON.parse(localStorage.getItem("opencode-web.config") || "{}") };
  } catch {
    return { ...defaultConfig };
  }
}
function saveConfig(cfg) {
  localStorage.setItem("opencode-web.config", JSON.stringify(cfg));
}

async function connect() {
  const cfg = loadConfig();
  client = new OpenCodeClient(cfg);
  setState({ config: cfg, connected: false });

  const health = await client.health();
  if (!health) {
    setState({ connected: false, health: null });
    scheduleReconnect();
    return false;
  }
  setState({ connected: true, health });
  await refreshAll();
  connectEvents();
  return true;
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
}

function connectEvents() {
  if (!client) return;
  disconnectEvents();

  // Streaming/polling strategy: with HTTP Basic auth EventSource can't carry
  // the header, so we fall back to a lightweight poller. Without auth we use
  // a real SSE stream for low-latency updates.
  if (client.useAuth) {
    startPolling();
  } else {
    es = client.connect();
    if (es) {
      es.onopen = () => {};
      es.onmessage = (ev) => {
        try {
          handleEvent(JSON.parse(ev.data));
        } catch (e) {
          /* ignore malformed event */
        }
      };
      es.onerror = () => {
        es.close();
        disconnectEvents();
        scheduleReconnect();
      };
    } else {
      startPolling();
    }
  }
}

function disconnectEvents() {
  if (es) {
    es.close();
    es = null;
  }
  clearInterval(pollTimer);
}

let pollTimer = null;
let lastPollToken = null;
async function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!client || !getState().connected) {
      const h = await client?.health();
      if (!h) {
        setState({ connected: false });
        scheduleReconnect();
        return;
      }
    }
    await pollForChanges();
  }, 2500);
  pollForChanges();
}

async function pollForChanges() {
  if (getState().busy) return; // busy path updates via the POST response
  try {
    const data = await client.messages(getState().currentSessionId);
    const token = JSON.stringify(data);
    if (token !== lastPollToken) {
      lastPollToken = token;
      setState({ messages: data });
      markMessagesDirty();
      render(getState());
    }
  } catch (e) {
    /* ignore transient */
  }
}

/* --------------------------------------------------------------------------
 * Event handling (SSE)
 * -------------------------------------------------------------------------- */

function handleEvent(ev) {
  const type = ev.type;
  const p = ev.properties || {};
  const id = getState().currentSessionId;

  switch (type) {
    case "server.connected":
      break;
    case "session.updated":
    case "session.created":
      refreshSessions();
      break;
    case "session.deleted":
      refreshSessions();
      break;
    case "session.status": {
      const status = p.status;
      if (p.sessionID === id) {
        const busy = status && status.type === "busy";
        setState({ busy });
      }
      break;
    }
    case "session.idle":
      if (p.sessionID === id) setState({ busy: false });
      break;
    case "message.updated":
      // final message metadata (roles/models) — update messages in place
      if (p.sessionID === id) {
        const info = p.info;
        const msgs = getState().messages;
        const idx = msgs.findIndex((m) => m.info.id === info.id);
        if (idx >= 0) {
          msgs[idx] = { ...msgs[idx], info };
          markMessagesDirty();
          render(getState());
        }
      }
      break;
    case "message.part.updated":
      if (p.sessionID === id) {
        applyPartUpdate(p.part, p.delta);
      }
      break;
    case "message.part.removed":
      if (p.sessionID === id) {
        const el = document.querySelector(`[data-tool-id="${CSS.escape(p.partID)}"]`);
        el?.remove();
      }
      break;
    case "todo.updated":
      if (p.sessionID === id) {
        setState({ todos: p.todos || [] });
        renderTodos();
      }
      break;
    case "session.diff":
      if (p.sessionID === id) {
        const badge = $("changes-count");
        const n = (p.diff || []).length;
        if (badge) {
          badge.textContent = n;
          badge.classList.toggle("hidden", !n);
        }
        if ($("changes-panel").classList.contains("open")) renderDiff(p.diff || []);
      }
      break;
    case "permission.updated": {
      const st = getState();
      const list = (st.permissions || []).filter((x) => x.id !== p.id);
      list.push(p);
      setState({ permissions: list });
      renderPendingPrompts(getState());
      break;
    }
    case "permission.replied": {
      const st = getState();
      setState({ permissions: (st.permissions || []).filter((x) => x.id !== p.permissionID) });
      renderPendingPrompts(getState());
      break;
    }
    case "question.asked": {
      const st = getState();
      const list = (st.questions || []).filter((x) => x.id !== p.id);
      list.push(p);
      setState({ questions: list });
      renderPendingPrompts(getState());
      break;
    }
    case "question.replied": {
      const st = getState();
      setState({ questions: (st.questions || []).filter((x) => x.id !== p.requestID) });
      renderPendingPrompts(getState());
      break;
    }
    default:
      break;
  }
}

function applyPartUpdate(part, delta) {
  const id = getState().currentSessionId;
  const msgs = getState().messages;

  // Find target message
  let msgIdx = msgs.findIndex((m) => m.info.id === part.messageID);
  if (msgIdx < 0) {
    // Streaming may create the assistant message lazily; ignore until message.updated arrives.
    return;
  }

  const parts = msgs[msgIdx].parts;
  const pidx = parts.findIndex((p) => p.id === part.id);

  // Accumulate streamed text deltas
  if (part.type === "text" && part.text == null && delta !== undefined) {
    if (pidx >= 0) {
      parts[pidx] = { ...parts[pidx], text: (parts[pidx].text || "") + delta };
    } else {
      parts.push({ ...part, text: delta });
    }
  } else if (pidx >= 0) {
    parts[pidx] = part;
  } else {
    parts.push(part);
  }

  setState({ messages: msgs });

  // Incremental DOM update for the specific part
  const el = document.querySelector(`[data-tool-id="${CSS.escape(part.id)}"]`);
  if (part.type === "text") {
    updateStreamingText(part, delta);
  } else if (el) {
    updatePartDOM(part);
  } else {
    // New part not yet in DOM — cheap full-ish update
    markMessagesDirty();
    render(getState());
  }
}

let streamingByMessage = new Map(); // messageID -> node

function updateStreamingText(part, delta) {
  const row = document.querySelector(`[data-message-id="${CSS.escape(part.messageID)}"]`);
  if (!row) {
    markMessagesDirty();
    render(getState());
    return;
  }
  let node = streamingByMessage.get(part.messageID);
  if (!node) {
    const body = row.querySelector(".message-body");
    node = makeStreamingTextNode();
    body.appendChild(node.wrap);
    streamingByMessage.set(part.messageID, node);
  }
  node.p.textContent += delta || "";
  scrollBottom();
}

/* --------------------------------------------------------------------------
 * Data refresh
 * -------------------------------------------------------------------------- */

async function refreshAll() {
  await Promise.all([
    refreshSessions(),
    refreshProviders(),
    refreshAgents(),
    refreshCommands(),
  ]);
  // select most recent session or create one
  const st = getState();
  const target = st.sessions.find((s) => s.id === st.currentSessionId);
  if (!target) {
    if (st.sessions.length) {
      st.currentSessionId = st.sessions[0].id;
      await loadSession(st.currentSessionId);
    }
  } else {
    await loadSession(st.currentSessionId);
  }
  render(st);
}

async function refreshSessions() {
  if (!client) return;
  try {
    const list = await client.listSessions();
    setState({ sessions: list });
  } catch (e) {
    setState({ connected: false });
  }
}

async function refreshProviders() {
  if (!client) return;
  try {
    const res = await client.providers();
    const models = [];
    let defaultModel = null;
    // Real 1.18.25 /provider => { all: Provider[], default: {...}, connected: [] }
    // Older /config/providers => { providers: Provider[], default: {...} }
    const list = (res && (res.all || res.providers)) || [];
    const defaults = (res && res.default) || {};
    for (const prov of list) {
      const pid = prov.id;
      for (const m of Object.values(prov.models || {})) {
        models.push({ id: m.id, providerID: pid, name: m.name || m.id });
      }
      if (!defaultModel && defaults[pid]) defaultModel = defaults[pid];
    }
    setState({ models, defaultModel });
    renderModels();
  } catch (e) {
    /* ignore */
  }
}

async function refreshAgents() {
  if (!client) return;
  try {
    const agents = await client.agents();
    setState({ agents });
    renderAgents();
  } catch (e) {
    /* ignore */
  }
}

/* --------------------------------------------------------------------------
 * Sessions: create / select / delete
 * -------------------------------------------------------------------------- */

async function newSession() {
  if (!client) return;
  const s = await client.createSession();
  setState({ currentSessionId: s.id, messages: [], busy: false });
  closeSidebarOnMobile();
  markMessagesDirty();
  await refreshSessions();
  render(getState());
  $("input").focus();
}

async function selectSession(id) {
  if (!client) return;
  setState({ currentSessionId: id, messages: [], busy: false });
  closeSidebarOnMobile();
  await loadSession(id);
  markMessagesDirty();
  render(getState());
}

async function loadSession(id) {
  if (!client || !id) return;
  try {
    const msgs = await client.messages(id);
    setState({ messages: msgs });
    markMessagesDirty();
    render(getState());
    await refreshTodos();
    await refreshDiffBadge();
  } catch (e) {
    /* ignore */
  }
}

async function deleteSession(id) {
  if (!client) return;
  await client.deleteSession(id);
  await refreshSessions();
  const st = getState();
  // If deleting current, switch to another; else stay
  if (st.currentSessionId === id) {
    const next = st.sessions.find((s) => s.id !== id) || null;
    st.currentSessionId = next ? next.id : null;
    st.messages = [];
    if (next) await loadSession(next.id);
  }
  markMessagesDirty();
  render(st);
}

/* --------------------------------------------------------------------------
 * Sending messages
 * -------------------------------------------------------------------------- */

async function sendPrompt(text) {
  if (!client || !text.trim()) return;
  const st = getState();
  let sessionId = st.currentSessionId;
  if (!sessionId) {
    const s = await client.createSession();
    sessionId = s.id;
    setState({ currentSessionId: sessionId });
    await refreshSessions();
  }

  const sel = $("model-select");
  const opt = sel.selectedOptions && sel.selectedOptions[0];
  // Real API expects model as { providerID, modelID }
  const model =
    opt && opt.value
      ? { providerID: opt.dataset.provider, modelID: opt.value }
      : st.defaultModel
      ? { providerID: st.defaultModel.split("/")[0], modelID: st.defaultModel.split("/")[1] }
      : undefined;
  const agent = $("agent-select").value || undefined;

  const mode = localStorage.getItem(MODE_KEY) || "serve";
  setState({ busy: true, prompt: "" });

  try {
    if (mode === "async") {
      await client.promptAsync(sessionId, {
        parts: [{ type: "text", text }],
        model,
        agent,
      });
      // New assistant message will be created server-side; rely on poller/SSE
      render(getState());
    } else {
      const res = await client.send(sessionId, {
        parts: [{ type: "text", text }],
        model,
        agent,
      });
      // res = { info, parts }
      const msgs = getState().messages;
      // add user message if not already present (sync mode returns only assistant)
      msgs.push({ info: res.info, parts: res.parts });
      setState({ messages: msgs });
      markMessagesDirty();
      render(getState());
    }
  } catch (e) {
    toast(`发送失败：${e.message || e}`);
  } finally {
    setState({ busy: false });
    render(getState());
  }
}

async function stopGenerating() {
  const id = getState().currentSessionId;
  if (!client || !id) return;
  try {
    await client.abortSession(id);
    setState({ busy: false });
    render(getState());
  } catch (e) {
    toast(`停止失败：${e.message}`);
  }
}

/* --------------------------------------------------------------------------
 * Model / agent selects
 * -------------------------------------------------------------------------- */

function renderModels() {
  const sel = $("model-select");
  const st = getState();
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = st.models.length ? `默认模型 (${st.models.length})` : "默认模型";
  sel.appendChild(none);
  for (const m of st.models) {
    const o = document.createElement("option");
    o.value = `${m.id}`;
    o.dataset.provider = m.providerID;
    o.textContent = m.name || m.id;
    o.title = `${m.providerID} / ${m.id}`;
    sel.appendChild(o);
  }
}

function renderAgents() {
  const sel = $("agent-select");
  const st = getState();
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "默认智能体";
  sel.appendChild(none);
  // Internal helpers are not meant to be chosen by the user.
  const INTERNAL = new Set(["compaction", "summary", "title", "compaction-agent"]);
  for (const a of st.agents) {
    // Real 1.18.25 /agent uses `mode: "primary" | "subagent"` (no `primary` boolean).
    if (a.mode && a.mode !== "primary") continue;
    if (INTERNAL.has(a.name)) continue;
    const o = document.createElement("option");
    o.value = a.name;
    o.textContent = a.name;
    o.title = a.description || a.name;
    sel.appendChild(o);
  }
}

/* --------------------------------------------------------------------------
 * Modals + theme
 * -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
 * Changes panel (diff / 更改历史)
 * -------------------------------------------------------------------------- */

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function parseDiff(before, after) {
  const a = (before || "").split("\n");
  const b = (after || "").split("\n");
  const lines = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const av = i < a.length ? a[i] : undefined;
    const bv = i < b.length ? b[i] : undefined;
    if (av === bv) lines.push({ t: "ctx", oldN: i + 1, newN: i + 1, text: av });
    else {
      if (av !== undefined) lines.push({ t: "del", oldN: i + 1, newN: "", text: av });
      if (bv !== undefined) lines.push({ t: "add", oldN: "", newN: i + 1, text: bv });
    }
  }
  return lines;
}

function shortPath(p) {
  const parts = String(p).split("/");
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
}

async function loadDiff() {
  const id = getState().currentSessionId;
  if (!client || !id) return;
  const body = $("changes-body");
  body.innerHTML = `<div class="muted" style="padding:14px;font-size:12px">加载中…</div>`;
  try {
    const diffs = await client.diff(id);
    setState({ diffs: diffs || [] });
    renderDiff(diffs || []);
  } catch (e) {
    body.innerHTML = `<div class="muted" style="padding:14px;font-size:12px;color:var(--danger)">加载失败：${escapeHtml(e.message || e)}</div>`;
  }
}

function renderDiff(diffs) {
  const body = $("changes-body");
  const count = $("changes-count");
  body.innerHTML = "";
  count.textContent = diffs.length;
  count.classList.toggle("hidden", !diffs.length);

  let add = 0, del = 0;
  for (const d of diffs) { add += d.additions || 0; del += d.deletions || 0; }
  $("changes-summary").textContent = diffs.length ? `${diffs.length} 个文件 · +${add} -${del}` : "";

  const st = getState();
  if (st.revertState) {
    const banner = document.createElement("div");
    banner.className = "revert-banner";
    const span = document.createElement("span");
    span.textContent = "已回退到该消息之前";
    const btn = document.createElement("button");
    btn.textContent = "恢复全部";
    btn.addEventListener("click", doUnrevert);
    banner.append(span, btn);
    body.appendChild(banner);
  }

  if (!diffs.length) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.cssText = "padding:30px 14px;text-align:center;font-size:12.5px";
    empty.textContent = "本次会话暂无文件更改";
    body.appendChild(empty);
    return;
  }

  for (const d of diffs) {
    const box = document.createElement("div");
    box.className = "diff-file";
    const head = document.createElement("div");
    head.className = "diff-head";
    const nm = document.createElement("span");
    nm.className = "fname";
    nm.textContent = shortPath(d.file);
    nm.title = d.file;
    const s1 = document.createElement("span");
    s1.className = "diff-stat add"; s1.textContent = `+${d.additions || 0}`;
    const s2 = document.createElement("span");
    s2.className = "diff-stat del"; s2.textContent = `-${d.deletions || 0}`;
    head.append(nm, s1, s2);

    const bodyEl = document.createElement("div");
    bodyEl.className = "diff-body";
    for (const ln of parseDiff(d.before, d.after)) {
      const row = document.createElement("div");
      row.className = `diff-line ${ln.t}`;
      const n = document.createElement("span");
      n.className = "ln";
      n.textContent = ln.t === "add" ? ln.newN : ln.oldN;
      const tx = document.createElement("span");
      tx.textContent = (ln.t === "add" ? "+" : ln.t === "del" ? "-" : " ") + (ln.text ?? "");
      row.append(n, tx);
      bodyEl.appendChild(row);
    }
    box.append(head, bodyEl);
    body.appendChild(box);
  }
}

function openChanges() { $("changes-panel").classList.add("open"); loadDiff(); }
function closeChanges() { $("changes-panel").classList.remove("open"); }

async function doUnrevert() {
  const id = getState().currentSessionId;
  if (!client || !id) return;
  try {
    await client.unrevert(id);
    setState({ revertState: null });
    await loadSession(id);
    await loadDiff();
    toast("已恢复被回退的内容");
  } catch (e) { toast(`恢复失败：${e.message || e}`); }
}

async function revertToMessage(messageID) {
  const id = getState().currentSessionId;
  if (!client || !id) return;
  try {
    await client.revert(id, messageID);
    setState({ revertState: { messageID } });
    await loadSession(id);
    await loadDiff();
    toast("已回退到该消息之前");
  } catch (e) { toast(`回退失败：${e.message || e}`); }
}

async function refreshDiffBadge() {
  const id = getState().currentSessionId;
  if (!client || !id) return;
  try {
    const diffs = await client.diff(id);
    setState({ diffs: diffs || [] });
    const badge = $("changes-count");
    if (badge) {
      badge.textContent = (diffs || []).length;
      badge.classList.toggle("hidden", !(diffs || []).length);
    }
    if ($("changes-panel").classList.contains("open")) renderDiff(diffs || []);
  } catch (e) { /* ignore */ }
}

/* --------------------------------------------------------------------------
 * Session actions menu
 * -------------------------------------------------------------------------- */

function closeMenus() { $("session-menu").classList.add("hidden"); }

async function doRename() {
  closeMenus();
  const st = getState();
  const cur = st.sessions.find((s) => s.id === st.currentSessionId);
  const name = prompt("会话名称", cur ? cur.title : "");
  if (name === null) return;
  try {
    await client.renameSession(st.currentSessionId, name);
    await refreshSessions();
    render(getState());
    toast("已重命名");
  } catch (e) { toast(`重命名失败：${e.message || e}`); }
}

async function doFork() {
  closeMenus();
  const st = getState();
  try {
    const s = await client.fork(st.currentSessionId);
    setState({ currentSessionId: s.id, messages: [] });
    await refreshSessions();
    await loadSession(s.id);
    markMessagesDirty();
    render(getState());
    toast("已创建新分支会话");
  } catch (e) { toast(`分支失败：${e.message || e}`); }
}

async function doSummarize() {
  closeMenus();
  const st = getState();
  try {
    await client.summarize(st.currentSessionId, {
      providerID: st.defaultModel ? st.defaultModel.split("/")[0] : undefined,
      modelID: st.defaultModel ? st.defaultModel.split("/")[1] : undefined,
    });
    await loadSession(st.currentSessionId);
    markMessagesDirty();
    render(getState());
    toast("已生成摘要");
  } catch (e) { toast(`摘要失败：${e.message || e}`); }
}

async function doShare() {
  closeMenus();
  const st = getState();
  try {
    const s = await client.share(st.currentSessionId);
    await refreshSessions();
    render(getState());
    if (s && s.share && s.share.url) prompt("分享链接", s.share.url);
    toast("已分享");
  } catch (e) { toast(`分享失败：${e.message || e}`); }
}

async function doUnshare() {
  closeMenus();
  const st = getState();
  try {
    await client.unshare(st.currentSessionId);
    await refreshSessions();
    render(getState());
    toast("已取消分享");
  } catch (e) { toast(`操作失败：${e.message || e}`); }
}

/* --------------------------------------------------------------------------
 * Permission / question prompts
 * -------------------------------------------------------------------------- */

function renderPendingPrompts(state) {
  const host = $("pending-prompts");
  if (!host) return;
  host.innerHTML = "";
  for (const p of state.permissions || []) host.appendChild(buildPermissionCard(p));
  for (const q of state.questions || []) host.appendChild(buildQuestionCard(q));
}

function buildPermissionCard(p) {
  const card = document.createElement("div");
  card.className = "prompt-card";
  const t = document.createElement("div");
  t.className = "p-title"; t.textContent = p.title || "需要权限";
  const d = document.createElement("div");
  d.className = "p-desc";
  d.textContent = p.pattern ? String(p.pattern) : p.metadata ? JSON.stringify(p.metadata) : "";
  const acts = document.createElement("div");
  acts.className = "prompt-actions";
  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  acts.append(
    mk("允许一次", "primary", () => answerPermission(p, "once")),
    mk("本次会话允许", "", () => answerPermission(p, "always")),
    mk("拒绝", "danger", () => answerPermission(p, "reject"))
  );
  card.append(t, d, acts);
  return card;
}

async function answerPermission(p, response) {
  try {
    await client.replyPermission(p.sessionID, p.id, response);
    const st = getState();
    st.permissions = (st.permissions || []).filter((x) => x.id !== p.id);
    setState({ permissions: st.permissions });
    renderPendingPrompts(getState());
  } catch (e) { toast(`操作失败：${e.message || e}`); }
}

function buildQuestionCard(q) {
  const card = document.createElement("div");
  card.className = "prompt-card";
  const t = document.createElement("div");
  t.className = "p-title"; t.textContent = q.header || q.question || "需要确认";
  const d = document.createElement("div");
  d.className = "p-desc"; d.textContent = q.question || "";
  card.append(t, d);
  const acts = document.createElement("div");
  acts.className = "prompt-actions";
  (q.options || []).forEach((opt, i) => {
    const b = document.createElement("button");
    if (i === 0) b.className = "primary";
    b.textContent = opt.label || String(opt);
    b.addEventListener("click", async () => {
      try {
        await client.replyQuestion(q.id, [opt.label || String(opt)]);
        const st = getState();
        st.questions = (st.questions || []).filter((x) => x.id !== q.id);
        setState({ questions: st.questions });
        renderPendingPrompts(getState());
      } catch (e) { toast(`回复失败：${e.message || e}`); }
    });
    acts.appendChild(b);
  });
  card.appendChild(acts);
  return card;
}

/* --------------------------------------------------------------------------
 * Slash commands
 * -------------------------------------------------------------------------- */

function showCommandPopup(filter) {
  const pop = $("cmd-pop");
  const st = getState();
  const q = (filter || "").toLowerCase();
  const matches = (st.commands || []).filter((c) => !q || c.name.toLowerCase().includes(q));
  if (!matches.length) { pop.classList.add("hidden"); return; }
  pop.innerHTML = "";
  matches.forEach((c, i) => {
    const el = document.createElement("button");
    el.className = "cmd-item" + (i === 0 ? " active" : "");
    const n = document.createElement("span");
    n.className = "cn"; n.textContent = "/" + c.name;
    const d = document.createElement("span");
    d.className = "cd"; d.textContent = c.description || "";
    el.append(n, d);
    el.addEventListener("click", () => runSlashCommand(c.name));
    pop.appendChild(el);
  });
  pop.classList.remove("hidden");
}

function hideCommandPopup() { $("cmd-pop").classList.add("hidden"); }

async function runSlashCommand(name) {
  hideCommandPopup();
  const st = getState();
  let sid = st.currentSessionId;
  if (!sid) {
    const s = await client.createSession();
    sid = s.id;
    setState({ currentSessionId: sid });
    await refreshSessions();
  }
  const input = $("input");
  const rest = (input.value || "").replace(/^\/\S+\s*/, "").trim();
  input.value = "";
  setState({ prompt: "", busy: true });
  try {
    await client.runCommand(sid, { command: name, arguments: rest });
    await loadSession(sid);
    markMessagesDirty();
    render(getState());
  } catch (e) { toast(`命令失败：${e.message || e}`); }
  finally { setState({ busy: false }); render(getState()); }
}

/* --------------------------------------------------------------------------
 * Todos
 * -------------------------------------------------------------------------- */

async function refreshTodos() {
  if (!client) return;
  const id = getState().currentSessionId;
  if (!id) return;
  try {
    const todos = await client.todos(id);
    setState({ todos: todos || [] });
    renderTodos();
  } catch (e) { /* ignore */ }
}

function renderTodos() {
  const st = getState();
  const host = $("todo-box");
  if (!host) return;
  if (!st.todos || !st.todos.length) { host.classList.add("hidden"); return; }
  host.classList.remove("hidden");
  host.innerHTML = "";
  const head = document.createElement("div");
  head.className = "t-head";
  head.textContent = `待办 (${st.todos.filter((t) => t.status === "completed").length}/${st.todos.length})`;
  host.appendChild(head);
  for (const t of st.todos) {
    const row = document.createElement("div");
    row.className = "todo-item" + (t.status === "completed" ? " done" : "");
    const s = document.createElement("span");
    s.className = "st " + (t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : t.status === "cancelled" ? "cancelled" : "pending");
    s.textContent = t.status === "completed" ? "✓" : t.status === "in_progress" ? "◐" : t.status === "cancelled" ? "✕" : "○";
    const tx = document.createElement("span");
    tx.className = "tx"; tx.textContent = t.content;
    row.append(s, tx);
    host.appendChild(row);
  }
}

async function refreshCommands() {
  if (!client) return;
  try {
    const commands = await client.commands();
    setState({ commands });
  } catch (e) { /* ignore */ }
}

/* --------------------------------------------------------------------------
 * Modals
 * -------------------------------------------------------------------------- */

function openThemeModal() {
  $("theme-modal").classList.remove("hidden");
  $("settings-modal").classList.add("hidden");
  $("overlay").classList.add("open");
  renderThemeGrid();
}

function openSettingsModal() {
  $("settings-modal").classList.remove("hidden");
  $("theme-modal").classList.add("hidden");
  $("overlay").classList.add("open");
  const c = getState().config;
  $("cfg-baseurl").value = c.baseUrl;
  $("cfg-username").value = c.username;
  $("cfg-password").value = c.password;
}

function closeModal() {
  $("overlay").classList.remove("open");
}

function bindEvents() {
  $("btn-new-session").addEventListener("click", newSession);
  $("btn-empty-settings").addEventListener("click", openSettingsModal);
  $("btn-settings").addEventListener("click", openSettingsModal);
  $("btn-theme").addEventListener("click", openThemeModal);
  $("btn-close-settings").addEventListener("click", closeModal);
  $("btn-cancel-settings").addEventListener("click", closeModal);
  $("btn-close-theme").addEventListener("click", closeModal);
  $("overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") closeModal();
  });

  $("btn-save-settings").addEventListener("click", async () => {
    const cfg = {
      baseUrl: $("cfg-baseurl").value.trim() || defaultConfig.baseUrl,
      username: $("cfg-username").value.trim() || "opencode",
      password: $("cfg-password").value,
    };
    saveConfig(cfg);
    closeModal();
    toast("正在连接服务器…");
    await connect();
  });

  $("btn-close-sidebar").addEventListener("click", () => setState({ sidebarOpen: false }));
  $("btn-open-sidebar").addEventListener("click", () => setState({ sidebarOpen: true }));
  $("sidebar-backdrop").addEventListener("click", () => setState({ sidebarOpen: false }));

  // Composer
  const input = $("input");
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
    setState({ prompt: input.value });
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt(input.value);
    }
  });

  $("send-btn").addEventListener("click", () => {
    const st = getState();
    if (st.busy) stopGenerating();
    else sendPrompt($("input").value);
  });

  // ---- Changes drawer ----
  $("btn-changes").addEventListener("click", () => {
    const p = $("changes-panel");
    if (p.classList.contains("open")) closeChanges();
    else openChanges();
  });
  $("btn-close-changes").addEventListener("click", closeChanges);
  $("btn-unrevert").addEventListener("click", doUnrevert);

  // ---- Session menu ----
  $("btn-session-menu").addEventListener("click", (e) => {
    e.stopPropagation();
    $("session-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#session-menu") && !e.target.closest("#btn-session-menu")) closeMenus();
  });
  $("mi-rename").addEventListener("click", doRename);
  $("mi-fork").addEventListener("click", doFork);
  $("mi-summarize").addEventListener("click", doSummarize);
  $("mi-share").addEventListener("click", doShare);
  $("mi-unshare").addEventListener("click", doUnshare);
  $("mi-delete").addEventListener("click", () => {
    closeMenus();
    const id = getState().currentSessionId;
    if (id && confirm("确定删除这个会话？")) deleteSession(id);
  });

  // ---- Slash commands ----
  input.addEventListener("input", () => {
    const v = input.value;
    if (v.startsWith("/")) showCommandPopup(v.slice(1).split(/\s/)[0]);
    else hideCommandPopup();
  });
  input.addEventListener("keydown", (e) => {
    const pop = $("cmd-pop");
    if (pop.classList.contains("hidden")) return;
    const items = [...pop.querySelectorAll(".cmd-item")];
    let idx = items.findIndex((i) => i.classList.contains("active"));
    const setActive = (k) => items.forEach((i, j) => i.classList.toggle("active", j === k));
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(idx + 1, items.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(idx - 1, 0)); return; }
    if (e.key === "Escape") { hideCommandPopup(); return; }
    if (e.key === "Tab" || (e.key === "Enter" && items.length)) {
      e.preventDefault();
      items[Math.max(idx, 0)]?.click();
    }
  });

  // ---- Global shortcuts ----
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      const p = $("changes-panel");
      if (p.classList.contains("open")) closeChanges();
      else openChanges();
    }
    if (e.key === "Escape") { closeChanges(); closeMenus(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      $("input").focus();
    }
  });

  // Actions for render.js
  setActions({
    onSelectSession: selectSession,
    onDeleteSession: deleteSession,
    onPickTheme: (id) => {
      setTheme(id);
      setState({ theme: id });
      renderThemeGrid();
      closeModal();
      toast(`已切换到主题`);
    },
  });
}

function renderThemeGrid() {
  const grid = $("theme-grid");
  const current = getTheme();
  grid.innerHTML = "";
  for (const t of THEMES) {
    const el = document.createElement("div");
    el.className = "theme-choice" + (t.id === current ? " active" : "");
    const sw = document.createElement("div");
    sw.className = "theme-swatch";
    for (const c of t.swatch) {
      const seg = document.createElement("span");
      seg.style.background = c;
      sw.appendChild(seg);
    }
    const name = document.createElement("div");
    name.className = "t-name";
    name.textContent = t.name;
    el.append(sw, name);
    el.addEventListener("click", () => {
      setTheme(t.id);
      setState({ theme: t.id });
      renderThemeGrid();
      toast(`已切换到「${t.name}」主题`);
    });
    grid.appendChild(el);
  }
}

/* --------------------------------------------------------------------------
 * Toast
 * -------------------------------------------------------------------------- */

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* --------------------------------------------------------------------------
 * Init
 * -------------------------------------------------------------------------- */

function init() {
  setState({ theme: getTheme() });
  setActions({
    onSelectSession: selectSession,
    onDeleteSession: deleteSession,
  });
  bindEvents();
  renderThemeGrid();

  subscribe(() => {
    const s = getState();
    document.getElementById("sidebar").classList.toggle("open", s.sidebarOpen);
    document.getElementById("sidebar-backdrop").classList.toggle("open", s.sidebarOpen);
  });

  render(getState());
  connect();
}

// On mobile the sidebar overlays the chat, so hide it after picking a session.
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) setState({ sidebarOpen: false });
}

window.__revertToMessage = revertToMessage;
window.__renderDiff = renderDiff;

init();
