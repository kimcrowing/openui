import { sentryVitePlugin } from "@sentry/vite-plugin"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import desktopPlugin, { channel } from "./vite.js"
import { icons } from "./vite.icons"

// GitHub Pages 子路径部署（VITE_BASE=/openui/）：
//  - base 注入，使产物/路由前缀可配置；
//  - serviceWorker（上游 vite.pwa.ts）故意移除：本部署用 404.html 做 SPA
//    fallback（历史路由），上游 SW 的 navigateFallback 是根路径锚定的，
//    在子路径下会破坏刷新；如需二次开启可恢复该插件并 patch navigateFallback。
const base = process.env.VITE_BASE ?? "/"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, icons(channel), sentry] as any,
  base,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    assetsDir: "_assets",
    target: "esnext",
    sourcemap: false,
  },
})