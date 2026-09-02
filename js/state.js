/* ==========================================================================
 * Application state: a tiny observable store so the UI re-renders when data
 * changes, kept deliberately dependency-free.
 * ========================================================================== */

const listeners = new Set();
const state = {
  connected: false,
  health: null,
  sessions: [],          // Session[]
  currentSessionId: null,
  messages: [],          // { info, parts }[]
  currentMessageId: null, // the assistant message currently streaming
  models: [],            // [{ id, providerID, name }]
  defaultModel: null,    // "provider/model"
  agents: [],            // Agent[]
  commands: [],          // Command[]
  busy: false,           // a message is being generated in current session
  sidebarOpen: false,
  settingsOpen: false,
  theme: "system",
  themeModalOpen: false,
  servers: [],           // [{ id, name, baseUrl, username, password }]
  activeServerId: null,
  todoCollapsed: {},      // sessionId -> bool
  config: {
    baseUrl: "",
    username: "opencode",
    password: "",
  },
  prompt: "",
};

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  emit();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(state);
}
