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
const PART_KEY = "opencode-web.part"; // prompt cascade: user | assign | subtask | project
const KEY_SERVERS = "opencode-web.servers";
const KEY_ACTIVE = "opencode-web.active";

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

function hostFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname + (u.port ? ":" + u.port : "");
  } catch {
    return url;
  }
}

// Multi-server support. Configurations live in `opencode-web.servers` as an
// array; `opencode-web.active` names the current one. A single legacy
// `opencode-web.config` entry is migrated on first load.
function loadConfigState() {
  let servers = [];
  let active = null;
  try {
    servers = JSON.parse(localStorage.getItem(KEY_SERVERS) || "[]");
  } catch {
    servers = [];
  }
  try {
    active = localStorage.getItem(KEY_ACTIVE);
  } catch {
    active = null;
  }
  if (!servers.length) {
    try {
      const c = JSON.parse(localStorage.getItem("opencode-web.config") || "{}");
      if (c && (c.baseUrl || c.url)) {
        servers = [{
          id: "s1",
          name: hostFromUrl(c.baseUrl || c.url),
          baseUrl: c.baseUrl || c.url || "",
          username: c.username || "opencode",
          password: c.password || "",
        }];
        localStorage.setItem(KEY_SERVERS, JSON.stringify(servers));
      }
    } catch {
      /* ignore */
    }
  }
  if (!Array.isArray(servers) || !servers.length) {
    servers = [{ id: "s1", name: "本机", ...defaultConfig }];
    localStorage.setItem(KEY_SERVERS, JSON.stringify(servers));
  }
  if (!servers.find((s) => s.id === active)) active = servers[0].id;
  return { servers, activeServerId: active };
}

function persistServers() {
  const st = getState();
  localStorage.setItem(KEY_SERVERS, JSON.stringify(st.servers));
  localStorage.setItem(KEY_ACTIVE, st.activeServerId || "");
  const active = st.servers.find((s) => s.id === st.activeServerId);
  if (active) {
    localStorage.setItem(
      "opencode-web.config",
      JSON.stringify({ baseUrl: active.baseUrl, username: active.username, password: active.password })
    );
  }
}

function activeConfig() {
  const st = getState();
  const s = st.servers.find((x) => x.id === st.activeServerId);
  return s
    ? { baseUrl: s.baseUrl, username: s.username, password: s.password }
    : { ...defaultConfig };
}

async function connect() {
  const cfg = activeConfig();
  client = new OpenCodeClient(cfg);
  setState({ config: cfg, connected: false });

  const health = await client.health();
  if (!health) {
    setState({ connected: false, health: null });
    renderSrvDot(false);
    scheduleReconnect();
    return false;
  }
  setState({ connected: true, health });
  renderSrvDot(true);
  await refreshAll();
  connectEvents();
  return true;
}

function renderSrvDot(on) {
  const dot = $("srv-dot");
  if (dot) dot.classList.toggle("hidden", !on);
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

const CASCADE_LEVELS = [
  { part: "user", label: "默认" },
  { part: "assign", label: "分配智能体" },
  { part: "subtask", label: "子任务" },
  { part: "project", label: "项目" },
];

function currentCascade() {
  const p = localStorage.getItem(PART_KEY) || "user";
  return CASCADE_LEVELS.find((l) => l.part === p) || CASCADE_LEVELS[0];
}

function cycleCascade() {
  const cur = currentCascade();
  const next = CASCADE_LEVELS[(CASCADE_LEVELS.indexOf(cur) + 1) % CASCADE_LEVELS.length];
  localStorage.setItem(PART_KEY, next.part);
  const btn = $("btn-cascade");
  if (btn) btn.title = `提权等级：${next.label}`;
  toast(`提权等级：${next.label}`);
}

function initComposerControls() {
  const btn = $("btn-cascade");
  if (btn) btn.title = `提权等级：${currentCascade().label}`;
  const chk = $("remember-chk");
  if (chk) {
    try { chk.checked = localStorage.getItem("opencode-web.remember") === "1"; } catch (e) {}
  } else {
    return;
  }
  chk.addEventListener("change", () => {
    try { localStorage.setItem("opencode-web.remember", chk.checked ? "1" : "0"); } catch (e) {}
  });
}

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
  const promptPart = localStorage.getItem(PART_KEY) || "user";
  const remember = $("remember-chk") ? $("remember-chk").checked : false;
  const extra = {};
  if (promptPart && promptPart !== "user") extra.part = promptPart;
  if (remember) extra.remember = true;

  const mode = localStorage.getItem(MODE_KEY) || "serve";
  setState({ busy: true, prompt: "" });

  try {
    if (mode === "async") {
      await client.promptAsync(sessionId, {
        parts: [{ type: "text", text }],
        model,
        agent,
        ...extra,
      });
      // New assistant message will be created server-side; rely on poller/SSE
      render(getState());
    } else {
      const res = await client.send(sessionId, {
        parts: [{ type: "text", text }],
        model,
        agent,
        ...extra,
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

function openChanges() {
  $("changes-panel").classList.add("open");
  document.body.classList.add("changes-open");
  loadDiff();
}
function closeChanges() {
  $("changes-panel").classList.remove("open");
  document.body.classList.remove("changes-open");
}

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
  const done = st.todos.filter((t) => t.status === "completed").length;
  const isCollapsed = !!(st.todoCollapsed && st.todoCollapsed[st.currentSessionId]);
  const head = document.createElement("div");
  head.className = "t-head";
  const title = document.createElement("span");
  title.textContent = `待办 (${done}/${st.todos.length})`;
  const toggle = document.createElement("button");
  toggle.className = "t-toggle";
  toggle.title = isCollapsed ? "展开待办" : "折叠待办";
  toggle.innerHTML = isCollapsed
    ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  toggle.addEventListener("click", () => {
    const map = { ...(getState().todoCollapsed || {}) };
    map[getState().currentSessionId] = !map[getState().currentSessionId];
    setState({ todoCollapsed: map });
    renderTodos();
  });
  head.append(title, toggle);
  host.appendChild(head);
  if (isCollapsed) { host.classList.add("collapsed"); return; }
  host.classList.remove("collapsed");
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

let srvEditId = null; // id of server currently in the form; null = adding new

function srvTabs() {
  return Array.from(document.querySelectorAll("#srv-tabs .tab"));
}

function switchSrvTab(name) {
  for (const t of srvTabs()) t.classList.toggle("active", t.dataset.tab === name);
  for (const id of ["servers", "status", "mcp", "tools"]) {
    const pane = $("pane-" + id);
    if (pane) pane.classList.toggle("hidden", id !== name);
  }
}

function openSettingsModal() {
  $("settings-modal").classList.remove("hidden");
  $("theme-modal").classList.add("hidden");
  $("overlay").classList.add("open");
  switchSrvTab("servers");
  renderServerList();
  // Edit the active server by default
  const st = getState();
  loadServerForm(st.servers.find((s) => s.id === st.activeServerId) || st.servers[0] || null);
  updateSrvConnPill();
  refreshServerInfo();
}

function closeModal() {
  $("overlay").classList.remove("open");
}

function updateSrvConnPill() {
  const st = getState();
  const pill = $("srv-conn-pill");
  pill.textContent = st.connected
    ? `已连接${st.health && st.health.version ? " v" + st.health.version : ""}`
    : "未连接";
  pill.className = "srv-conn " + (st.connected ? "online" : "offline");
}

function renderServerList() {
  const host = $("srv-list");
  const st = getState();
  host.innerHTML = "";
  if (!st.servers.length) {
    host.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">暂无服务器，请在下方添加。</div>`;
    return;
  }
  const cur = st.connected ? st.activeServerId : null;
  for (const s of st.servers) {
    const card = document.createElement("div");
    card.className = "srv-card" + (s.id === st.activeServerId ? " active" : "");
    const led = document.createElement("span");
    led.className = "srv-led" + (s.id === cur ? " on" : "");
    led.title = s.id === cur ? "已连接" : "未连接";
    const main = document.createElement("div");
    main.className = "srv-main";
    const nm = document.createElement("div");
    nm.className = "srv-nm";
    nm.textContent = s.name || hostFromUrl(s.baseUrl) || s.baseUrl || "服务器";
    const url = document.createElement("div");
    url.className = "srv-url";
    url.textContent = s.baseUrl;
    url.title = s.baseUrl;
    main.append(nm, url);
    card.append(led, main);

    const acts = document.createElement("div");
    acts.className = "srv-acts";
    if (s.id === st.activeServerId) {
      const curBtn = document.createElement("button");
      curBtn.className = "btn-mini active";
      curBtn.textContent = "使用中";
      acts.appendChild(curBtn);
    } else {
      const use = document.createElement("button");
      use.className = "btn-mini";
      use.textContent = "使用";
      use.addEventListener("click", () => useServer(s.id));
      acts.appendChild(use);
    }
    const edit = document.createElement("button");
    edit.className = "btn-mini";
    edit.textContent = "编辑";
    edit.addEventListener("click", () => loadServerForm(s));
    acts.appendChild(edit);
    const del = document.createElement("button");
    del.className = "btn-mini danger";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteServer(s.id));
    acts.appendChild(del);
    card.append(acts);
    host.appendChild(card);
  }
}

function loadServerForm(s) {
  srvEditId = s ? s.id : null;
  $("srv-editing").value = s ? s.id : "";
  $("cfg-name").value = s ? s.name || "" : "";
  $("cfg-baseurl").value = s ? s.baseUrl || "" : "";
  $("cfg-username").value = s ? s.username || "opencode" : "opencode";
  $("cfg-password").value = s ? s.password || "" : "";
  $("srv-form-title").textContent = s ? `编辑服务器 · ${s.name || hostFromUrl(s.baseUrl) || s.baseUrl}` : "添加服务器";
}

function startAddServer() {
  srvEditId = null;
  $("srv-editing").value = "";
  $("cfg-name").value = "";
  $("cfg-baseurl").value = "";
  $("cfg-username").value = "opencode";
  $("cfg-password").value = "";
  $("srv-form-title").textContent = "添加服务器";
  $("cfg-baseurl").focus();
}

function readServerForm() {
  return {
    name: $("cfg-name").value.trim(),
    baseUrl: $("cfg-baseurl").value.trim(),
    username: $("cfg-username").value.trim() || "opencode",
    password: $("cfg-password").value,
  };
}

async function saveServersFromForm() {
  const data = readServerForm();
  if (!data.baseUrl) {
    toast("请填写服务器地址");
    return;
  }
  const st = getState();
  let servers = [...st.servers];
  let id = srvEditId;
  if (id && servers.find((s) => s.id === id)) {
    servers = servers.map((s) => (s.id === id ? { ...s, ...data } : s));
  } else {
    id = "s" + Date.now().toString(36);
    servers.push({ id, ...data });
  }
  setState({ servers, activeServerId: id });
  persistServers();
  setState({ config: activeConfig(), currentSessionId: null, messages: [] });
  renderServerList();
  loadServerForm(servers.find((s) => s.id === id));
  updateSrvConnPill();
  toast("正在连接服务器…");
  await connect();
  updateSrvConnPill();
  refreshServerInfo();
  switchSrvTab("status");
}

async function deleteServer(id) {
  if (!confirm("确定删除这个服务器配置？")) return;
  const st = getState();
  let servers = st.servers.filter((s) => s.id !== id);
  let active = st.activeServerId;
  if (active === id) active = servers.length ? servers[0].id : null;
  setState({ servers, activeServerId: active });
  persistServers();
  if (!servers.length) {
    client = null;
    setState({ config: { ...defaultConfig }, connected: false, currentSessionId: null, messages: [], sessions: [] });
  } else {
    setState({ config: activeConfig() });
    await connect();
  }
  renderServerList();
  loadServerForm(servers.find((s) => s.id === active) || null);
  updateSrvConnPill();
  switchSrvTab("servers");
}

async function useServer(id) {
  setState({ activeServerId: id });
  persistServers();
  setState({ config: activeConfig(), currentSessionId: null, messages: [] });
  renderServerList();
  loadServerForm(getState().servers.find((s) => s.id === id));
  updateSrvConnPill();
  toast("正在连接服务器…");
  await connect();
  updateSrvConnPill();
  refreshServerInfo();
  switchSrvTab("status");
}

/* --------------------------------------------------------------------------
 * Server info panel (状态 / MCP / 工具·插件)
 * -------------------------------------------------------------------------- */

async function refreshServerInfo() {
  const info = {
    health: null, path: null, project: null, vcs: null,
    sessions: null, providers: null, agents: null, mcp: null, tools: [],
  };
  if (client) {
    const jobs = [
      client.health(),
      client.path().catch(() => null),
      client.project().catch(() => null),
      client.vcs().catch(() => null),
      client.listSessions().catch(() => null),
      client.providers().catch(() => null),
      client.agents().catch(() => null),
      client.mcp().catch(() => null),
      client.toolIds().catch(() => null),
    ];
    const [h, path, project, vcs, sessions, providers, agents, mcp, tools] = await Promise.all(jobs);
    info.health = h;
    info.path = path;
    info.project = project;
    info.vcs = vcs;
    info.sessions = sessions;
    info.providers = providers;
    info.agents = agents;
    info.mcp = mcp;
    info.tools = tools || [];
  }
  renderStatusRows(info);
  renderMCPRows(info);
  renderToolsRows(info);
}

function renderStatusRows(info) {
  const host = $("srv-status-rows");
  if (!host) return;
  host.innerHTML = "";
  const rows = [];
  rows.push(["连接状态", info.health ? "已连接" : "未连接"]);
  if (info.health && info.health.version) rows.push(["服务器版本", info.health.version]);
  if (info.path && info.path.worktree) rows.push(["工作区", info.path.worktree]);
  if (info.path && info.path.directory) rows.push(["项目目录", info.path.directory]);
  if (info.project && info.project.id) rows.push(["项目 ID", info.project.id]);
  if (info.vcs && info.vcs.branch) rows.push(["Git 分支", info.vcs.branch]);
  if (Array.isArray(info.sessions)) rows.push(["会话", String(info.sessions.length) + " 个"]);
  if (info.providers) {
    const all = info.providers.all || info.providers.providers || [];
    const models = all.reduce((n, p) => n + Object.keys(p.models || {}).length, 0);
    rows.push(["模型", models + " 个 / " + all.length + " 家提供商"]);
  }
  if (Array.isArray(info.agents)) {
    const prim = info.agents.filter((a) => a.mode === "primary" || !a.mode).length;
    rows.push(["智能体", prim + " 个"]);
  }
  if (!rows.length) {
    host.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">暂无服务器信息。</div>`;
    return;
  }
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "insp-row";
    const kb = document.createElement("span");
    kb.className = "k"; kb.textContent = k;
    const vb = document.createElement("span");
    vb.className = "v"; vb.textContent = v;
    row.append(kb, vb);
    host.appendChild(row);
  }
}

function renderMCPRows(info) {
  const host = $("srv-mcp-rows");
  if (!host) return;
  host.innerHTML = "";
  const mcp = info.mcp;
  if (!mcp || typeof mcp !== "object") {
    host.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">暂无 MCP 服务器。</div>`;
    return;
  }
  const names = Object.keys(mcp);
  if (!names.length) {
    host.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">暂无 MCP 服务器。</div>`;
    return;
  }
  for (const name of names) {
    const status = String(mcp[name] && (mcp[name].status || mcp[name]) || "unknown");
    const row = document.createElement("div");
    row.className = "insp-row";
    const dot = document.createElement("span");
    dot.className = "dot-st " + (status === "connected" ? "ok" : status === "error" ? "err" : "warn");
    const kb = document.createElement("span");
    kb.className = "k"; kb.textContent = name;
    const badge = document.createElement("span");
    badge.className = "mcp-badge " + status;
    badge.textContent = status;
    const vb = document.createElement("span");
    vb.className = "v";
    row.append(dot, kb, vb, badge);
    host.appendChild(row);
  }
}

function renderToolsRows(info) {
  const host = $("srv-tools-rows");
  if (!host) return;
  host.innerHTML = "";
  const tools = info.tools || [];
  const head = document.createElement("div");
  head.className = "tools-head";
  head.textContent = `工具 / 插件：共 ${tools.length} 个`;
  host.appendChild(head);
  if (tools.length) {
    const wrap = document.createElement("div");
    wrap.className = "tools-chips";
    for (const t of tools) {
      const chip = document.createElement("span");
      chip.className = "tool-chip";
      chip.textContent = t;
      chip.title = t;
      wrap.appendChild(chip);
    }
    host.appendChild(wrap);
  }
}

function bindEvents() {
  $("btn-new-session").addEventListener("click", newSession);
  $("btn-empty-settings").addEventListener("click", openSettingsModal);
  $("btn-server").addEventListener("click", openSettingsModal);
  $("btn-cascade").addEventListener("click", cycleCascade);
  for (const t of srvTabs()) t.addEventListener("click", () => switchSrvTab(t.dataset.tab));
  $("btn-new-srv").addEventListener("click", startAddServer);
  $("btn-rm-srv").addEventListener("click", () => {
    const id = $("srv-editing").value;
    if (id) deleteServer(id);
    else toast("当前是新建状态，没有可删除的服务器");
  });
  $("btn-theme").addEventListener("click", openThemeModal);
  $("btn-close-settings").addEventListener("click", closeModal);
  $("btn-close-theme").addEventListener("click", closeModal);
  $("overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") closeModal();
  });

  $("btn-save-settings").addEventListener("click", saveServersFromForm);

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
  const loaded = loadConfigState();
  setState({
    servers: loaded.servers,
    activeServerId: loaded.activeServerId,
    config: activeConfig(),
  });
  setActions({
    onSelectSession: selectSession,
    onDeleteSession: deleteSession,
  });
  bindEvents();
  renderThemeGrid();
  initComposerControls();

  subscribe(() => {
    const s = getState();
    document.getElementById("sidebar").classList.toggle("open", s.sidebarOpen);
    document.getElementById("sidebar-backdrop").classList.toggle("open", s.sidebarOpen);
    const pill = document.getElementById("server-pill");
    if (pill) {
      pill.className = s.connected ? "pill online" : "pill offline";
      pill.lastChild.textContent = s.connected
        ? `已连接${s.health && s.health.version ? ` · v${s.health.version}` : ""}`
        : "未连接";
    }
    renderSrvDot(s.connected);
  });

  updateSrvConnPill();
  render(getState());
  connect();
}

// On mobile the sidebar overlays the chat, so hide it after picking a session.
function closeSidebarOnMobile() {
  if (window.innerWidth <= 768) setState({ sidebarOpen: false });
}

window.__revertToMessage = revertToMessage;
window.__renderDiff = renderDiff;
window.__ui = { getState, setState, renderTodos, openSettingsModal, switchSrvTab };

init();
