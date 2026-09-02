import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

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
  // VITE_BASE allows static subpath deployments (e.g. GitHub Pages "/openui/").
  // Default "/" keeps official behavior (server embed at origin root).
  base: process.env.VITE_BASE || "/",
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    // Static subpath deployment (Pages) has no local file access for maps;
    // disabling sourcemaps cuts payload and parse time. Set SENTRY_* or
    // vendored `.map` files are not needed for pure-static hosting.
    sourcemap: false,
    cssCodeSplit: true,
    minify: "esbuild",
  },
})
