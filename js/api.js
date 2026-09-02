/* ==========================================================================
 * API client for the opencode server.
 *
 * The opencode server is started with `opencode serve` (or `opencode web`).
 * It exposes a REST API plus a Server-Sent Events stream at /event.
 *
 * Because this UI is a static site on another origin, point it at a server
 * started with CORS enabled:
 *
 *   opencode serve --port 4096 --cors https://<your-github-pages-origin>
 *   (or --cors http://localhost:8000 when testing locally)
 *
 * Credentials: if OPENCODE_SERVER_PASSWORD is set, add HTTP Basic auth using
 * username "opencode" (or the configured OPENCODE_SERVER_USERNAME).
 * ========================================================================== */

export class OpenCodeClient {
  constructor({ baseUrl, username = "opencode", password = "" } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.username = username;
    this.password = password || "";
    this.token = btoa(`${this.username}:${this.password}`);
    this.useAuth = Boolean(password);
  }

  url(path) {
    return `${this.baseUrl}${path}`;
  }

  headers(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (this.useAuth) {
      h["Authorization"] = `Basic ${this.token}`;
    }
    return h;
  }

  async request(path, { method = "GET", body, query } = {}) {
    let url = this.url(path);
    if (query) {
      const qs = Object.entries(query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");
      if (qs) url += `?${qs}`;
    }

    const res = await fetch(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    // A 401 with auth configured usually means wrong password.
    if (res.status === 401) {
      throw new ApiError(401, "Authentication failed — check the password");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ApiError(res.status, `Request failed (${res.status})${text ? `: ${text}` : ""}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    const raw = await res.text();
    if (raw === "true") return true;
    if (raw === "false") return false;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return raw;
    }
  }

  // ---- Health / discovery ----
  async health() {
    try {
      const h = await this.request("/global/health").catch(() => this.request("/health"));
      return h && typeof h === "object" ? h : { healthy: true };
    } catch (e) {
      return null;
    }
  }

  // ---- Sessions ----
  listSessions() {
    return this.request("/session");
  }

  createSession(parentID, title) {
    return this.request("/session", {
      method: "POST",
      body: { parentID, title },
    });
  }

  getSession(id) {
    return this.request(`/session/${id}`);
  }

  deleteSession(id) {
    return this.request(`/session/${id}`, { method: "DELETE" });
  }

  renameSession(id, title) {
    return this.request(`/session/${id}`, { method: "PATCH", body: { title } });
  }

  sessionStatus() {
    return this.request("/session/status");
  }

  abortSession(id) {
    return this.request(`/session/${id}/abort`, { method: "POST" });
  }

  messages(id) {
    return this.request(`/session/${id}/message`);
  }

  send(id, body) {
    return this.request(`/session/${id}/message`, { method: "POST", body });
  }

  promptAsync(id, body) {
    return this.request(`/session/${id}/prompt_async`, { method: "POST", body });
  }

  children(id) {
    return this.request(`/session/${id}/children`);
  }

  todos(id) {
    return this.request(`/session/${id}/todo`);
  }

  diff(id, messageID) {
    return this.request(`/session/${id}/diff`, { query: { messageID } });
  }

  summarize(id, body) {
    return this.request(`/session/${id}/summarize`, { method: "POST", body });
  }

  share(id) {
    return this.request(`/session/${id}/share`, { method: "POST" });
  }

  unshare(id) {
    return this.request(`/session/${id}/share`, { method: "DELETE" });
  }

  fork(id, messageID) {
    return this.request(`/session/${id}/fork`, { method: "POST", body: { messageID } });
  }

  revert(id, messageID, partID) {
    return this.request(`/session/${id}/revert`, {
      method: "POST",
      body: { messageID, partID },
    });
  }

  unrevert(id) {
    return this.request(`/session/${id}/unrevert`, { method: "POST" });
  }

  runCommand(id, body) {
    return this.request(`/session/${id}/command`, { method: "POST", body });
  }

  runShell(id, body) {
    return this.request(`/session/${id}/shell`, { method: "POST", body });
  }

  // Permissions / questions (validated: IDs prefixed "per" / "que")
  replyPermission(id, permissionID, response, remember) {
    return this.request(`/session/${id}/permissions/${permissionID}`, {
      method: "POST",
      body: { response, remember },
    });
  }

  replyQuestion(requestID, answers) {
    return this.request(`/question/${requestID}/reply`, {
      method: "POST",
      body: { answers },
    });
  }

  // ---- Config ----
  config() {
    return this.request("/config");
  }

  path() {
    return this.request("/path");
  }

  vcs() {
    return this.request("/vcs");
  }

  project() {
    return this.request("/project/current");
  }

  // ---- Files ----
  listFiles(path) {
    return this.request("/file", { query: { path } });
  }

  readFile(path) {
    return this.request("/file/content", { query: { path } });
  }

  fileStatus() {
    return this.request("/file/status");
  }

  findFiles(query, type) {
    return this.request("/find/file", { query: { query, type } });
  }

  // ---- Diagnostics ----
  lsp() {
    return this.request("/lsp");
  }

  mcp() {
    return this.request("/mcp");
  }

  toolIds() {
    return this.request("/experimental/tool/ids");
  }

  // Note: official endpoint is /provider (newer) or /config/providers (older).
  async providers() {
    try {
      return await this.request("/provider");
    } catch (e) {
      return await this.request("/config/providers");
    }
  }

  agents() {
    return this.request("/agent");
  }

  commands() {
    return this.request("/command");
  }

  // ---- Event stream ----
  connect() {
    const es = new EventSource(this.url("/event"));
    if (this.useAuth) {
      // EventSource cannot set Authorization headers; fall back to polling
      // is handled by passing full URL with credentials is not supported.
      // We still attempt; if it fails, app falls back to refresh polling.
      es.close();
      return null;
    }
    return es;
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}
