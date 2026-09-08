import { createBrowserDraftStore } from "@/runtime/persistence/drafts"
import { ServerConnection } from "@/runtime/server/registry"
import type { Platform } from "./platform"

const DEFAULT_SERVER_URL_KEY = "opencode.settings.dat:defaultServerUrl"

export function createWebPlatform(version: string) {
  const currentServerUrl = getCurrentServerUrl()
  const storedServerUrl = readDefaultServerUrl()
  const platform: Platform = {
    platform: "web",
    draftStore: createBrowserDraftStore(),
    version,
    openExternal(value) {
      if (!URL.canParse(value)) return
      const url = new URL(value)
      if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return
      window.open(url.href, "_blank", "noopener,noreferrer")
    },
    restart: async () => window.location.reload(),
    async notify(title, description, onClick) {
      if (!("Notification" in window)) return

      const permission =
        Notification.permission === "default"
          ? await Notification.requestPermission().catch(() => "denied")
          : Notification.permission
      if (permission !== "granted") return
      if (document.visibilityState === "visible" && document.hasFocus()) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        window.focus()
        onClick?.()
        notification.close()
      }
    },
    getDefaultServer: async () => {
      const stored = readDefaultServerUrl()
      return stored ? ServerConnection.Key.make(stored) : null
    },
    setDefaultServer: writeDefaultServerUrl,
  }

  return {
    platform,
    currentServerUrl,
    defaultServerUrl: storedServerUrl ?? currentServerUrl,
  }
}

function getCurrentServerUrl() {
  // 子路径静态部署（GitHub Pages）场景：构建期注入默认 API 地址
  // （如 https://kimcrowing.dynv6.net:14096，见 workflow 的 VITE_DEFAULT_SERVER_URL）。
  if (import.meta.env.VITE_DEFAULT_SERVER_URL) return import.meta.env.VITE_DEFAULT_SERVER_URL
  if (location.hostname.includes("opencode.ai")) return "http://localhost:49374"
  if (import.meta.env.DEV)
    return `http://${import.meta.env.VITE_OPENCODE_SERVER_HOST ?? "localhost"}:${import.meta.env.VITE_OPENCODE_SERVER_PORT ?? "4096"}`
  return location.origin
}

function readDefaultServerUrl() {
  if (typeof localStorage === "undefined") return null
  try {
    return localStorage.getItem(DEFAULT_SERVER_URL_KEY)
  } catch {
    return null
  }
}

function writeDefaultServerUrl(value: string | null) {
  if (typeof localStorage === "undefined") return
  try {
    if (value !== null) {
      localStorage.setItem(DEFAULT_SERVER_URL_KEY, value)
      return
    }
    localStorage.removeItem(DEFAULT_SERVER_URL_KEY)
  } catch {
    return
  }
}