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
    case "session.diff":
      break;
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
  await Promise.all([refreshSessions(), refreshProviders(), refreshAgents()]);
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
  none.textContent = "默认模型";
  sel.appendChild(none);
  for (const m of st.models) {
    const o = document.createElement("option");
    o.value = `${m.id}`;
    o.dataset.provider = m.providerID;
    o.textContent = m.name || m.id;
    sel.appendChild(o);
  }
}

function renderAgents() {
  const sel = $("agent-select");
  const st = getState();
  sel.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "默认代理";
  sel.appendChild(none);
  for (const a of st.agents) {
    // Real 1.18.25 /agent uses `mode: "primary" | "subagent"` (no `primary` boolean).
    if (a.mode && a.mode !== "primary") continue;
    const o = document.createElement("option");
    o.value = a.name;
    o.textContent = a.name;
    sel.appendChild(o);
  }
}

/* --------------------------------------------------------------------------
 * Modals + theme
 * -------------------------------------------------------------------------- */

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

init();
