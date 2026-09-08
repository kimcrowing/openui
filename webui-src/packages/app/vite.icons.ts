import { readFileSync } from "node:fs"
import type { Plugin } from "vite"
import manifest from "./manifest.json" with { type: "json" }

// GitHub Pages 子路径部署：URL 引用一律加 VITE_BASE 前缀（默认 "/"），
// 否则产物/图标/manifest 均为根路径锚定，子路径下 404。
const base = process.env.VITE_BASE ?? "/"

export function icons(channel: string): Plugin {
  const selected = channel === "beta" || channel === "prod" ? channel : "dev"
  const prefix = `icons/${selected}`
  const files = [
    ...Object.entries({
      "favicon.ico": "icon.ico",
      "apple-touch-icon.png": "ios/AppIcon-60x60@3x.png",
      "web-app-manifest-192x192.png": "android/mipmap-xxxhdpi/ic_launcher.png",
      "web-app-manifest-512x512.png": "icon.png",
    }).map(([name, source]) => ({
      fileName: `${prefix}/${name}`,
      source: readFileSync(new URL(`../desktop/icons/${selected}/${source}`, import.meta.url)),
      type: name.endsWith(".ico") ? "image/x-icon" : "image/png",
    })),
    {
      fileName: "site.webmanifest",
      source: JSON.stringify({
        ...manifest,
        // base 以 "/" 结尾（如 /openui/）；start_url/scope/id 指向部署根。
        id: `${base}`,
        start_url: `${base}`,
        scope: `${base}`,
        icons: manifest.icons.map((icon) => ({ ...icon, src: `${base}${prefix}${icon.src}` })),
      }),
      type: "application/manifest+json",
    },
  ]

  return {
    name: "opencode-app:icons",
    generateBundle() {
      files.forEach((file) => this.emitFile({ type: "asset", fileName: file.fileName, source: file.source }))
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = files.find((file) => `/${file.fileName}` === request.url?.split("?")[0])
        if (!file) return next()
        response.setHeader("Content-Type", file.type)
        response.end(file.source)
      })
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return html
          .replace("%OPENCODE_FAVICON%", `${base}${prefix}/favicon.ico`)
          .replace("%OPENCODE_APPLE_TOUCH_ICON%", `${base}${prefix}/apple-touch-icon.png`)
      },
    },
  }
}