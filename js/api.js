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
    return raw;
  }

  // ---- Health / discovery ----
  async health() {
    try {
      const h = await this.request("/health").catch(() => this.request("/global/health"));
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

  // ---- Config ----
  config() {
    return this.request("/config");
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
