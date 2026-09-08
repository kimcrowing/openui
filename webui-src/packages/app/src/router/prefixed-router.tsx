// GitHub Pages 子路径部署（Vite base "/openui/"）专用 Router（@solidjs/router@1.0.0）。
//
// 原则（对照旧版 prefixed-router 结论，2026-09-08 实测证实）：
//   给 <Router base="/openui/"> 传 base 会让 useLocation().pathname 携带 "/openui" 前缀，
//   破坏官方代码的精确路径比较——最典型的是 shell/state/layout.tsx 的 currentRoute()：
//   parts[0] === "settings" / "new-session" / "server" 全部落空 → 抛错 → ErrorBoundary
//   （线上 TypeError: Cannot read properties of undefined (reading 'type')，
//    本地同 dist 仅 base 不同的对照实验：/openui/ 报错、根路径正常，铁证）。
//
// 正确方案：**不给 Router 传 base**，内部路径一律保持干净（"/"、"/settings" 等），
// 只在与浏览器 history 的边界做前缀转换：
//   - get()（读 window.location 初始 URL / popstate）剥掉 BASE_ROOT 前缀；
//   - set()（pushState/replaceState 写 history）加回 BASE_ROOT 前缀。
// 由此 useLocation().pathname 始终是干净路径，应用代码零改动即可在子路径下工作。
// 实现以官方 createRouter integration（Router.js + createRouter.js + setupNativeEvents）
// 为蓝本；setupNativeEvents / scrollToHash 未从包导出，此处复刻。
import { onCleanup } from "solid-js"
import {
  createRouter,
  createBeforeLeave,
  keepDepth,
  saveCurrentDepth,
  notifyIfNotBlocked,
} from "@solidjs/router"
import type { BaseRouterProps, LocationChange, RouterContext } from "@solidjs/router"

const BASE_ROOT = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")

function stripBase(value: string): string {
  if (!BASE_ROOT || value === "/") return value
  if (value === BASE_ROOT || value === `${BASE_ROOT}/`) return "/"
  if (value.startsWith(`${BASE_ROOT}/`)) return value.slice(BASE_ROOT.length)
  return value
}

function addBase(value: string): string {
  if (!BASE_ROOT || !value.startsWith("/")) return value
  if (value === "/") return `${BASE_ROOT}/`
  if (value.startsWith(`${BASE_ROOT}/`)) return value
  return `${BASE_ROOT}${value}`
}

// 官方 Router.js 中 scrollToHash 未从包导出，照搬其实现（@solidjs/router MIT）。
function scrollToHash(hash: string, fallbackTop?: boolean) {
  const el = hash && document.getElementById(hash)
  if (el) {
    el.scrollIntoView()
  } else if (fallbackTop) {
    window.scrollTo(0, 0)
  }
}

export function PrefixedRouter(props: BaseRouterProps) {
  const getSource = (): LocationChange => {
    const url = window.location.pathname.replace(/^\/+/, "/") + window.location.search
    const state =
      window.history.state && window.history.state._depth && Object.keys(window.history.state).length === 1
        ? undefined
        : window.history.state
    return { value: stripBase(url) + window.location.hash, state }
  }
  const beforeLeave = createBeforeLeave()
  const Router = createRouter({
    get: getSource,
    set({ value, replace, scroll, state }) {
      const url = addBase(value)
      if (replace) {
        window.history.replaceState(keepDepth(state), "", url)
      } else {
        window.history.pushState(state, "", url)
      }
      scrollToHash(decodeURIComponent(window.location.hash.slice(1)), scroll)
      saveCurrentDepth()
    },
    init: (notify) => {
      const onPop = notifyIfNotBlocked(notify, (delta: number | null) => {
        if (delta) {
          return !beforeLeave.confirm(delta)
        }
        const s = getSource()
        return !beforeLeave.confirm(s.value, { state: s.state })
      })
      window.addEventListener("popstate", onPop)
      return () => window.removeEventListener("popstate", onPop)
    },
    create: (router: RouterContext) => {
      // 官方 setupNativeEvents 未从包导出；复刻其 anchor 点击拦截精简版：
      // 同源、无修饰键、非 download/external 的 <a> 走 SPA 导航（href 可能带
      // 也不带 /openui 前缀，统一 strip 后再交给内部导航）。
      const navigateFromRoute = router.navigatorFactory(router.base)
      function isSvg(el: Element) {
        return el.namespaceURI === "http://www.w3.org/2000/svg"
      }
      function handleAnchor(evt: MouseEvent) {
        if (
          evt.defaultPrevented ||
          evt.button !== 0 ||
          evt.metaKey ||
          evt.altKey ||
          evt.ctrlKey ||
          evt.shiftKey
        )
          return
        const a = evt
          .composedPath()
          .find((el) => el instanceof Node && el.nodeName.toUpperCase() === "A") as
          | HTMLAnchorElement
          | undefined
        if (!a) return
        const href = isSvg(a) ? a.href.baseVal : a.href
        const target = isSvg(a) ? a.target.baseVal : a.target
        if (target || (!href && !a.hasAttribute("state"))) return
        const rel = (a.getAttribute("rel") || "").split(/\s+/)
        if (a.hasAttribute("download") || rel.includes("external")) return
        const url = isSvg(a) ? new URL(href, document.baseURI) : new URL(href)
        if (url.origin !== window.location.origin) return
        return [a, url] as const
      }
      function handleAnchorClick(evt: MouseEvent) {
        const res = handleAnchor(evt)
        if (!res) return
        const [a, url] = res
        const to = router.parsePath(stripBase(url.pathname) + url.search + url.hash)
        const state = a.getAttribute("state")
        evt.preventDefault()
        navigateFromRoute(to, {
          resolve: false,
          replace: a.hasAttribute("replace"),
          scroll: !a.hasAttribute("noscroll"),
          state: state ? JSON.parse(state) : undefined,
        })
      }
      document.addEventListener("click", handleAnchorClick)
      onCleanup(() => document.removeEventListener("click", handleAnchorClick))
    },
    utils: {
      go: (delta) => window.history.go(delta),
      beforeLeave,
    },
  })
  return <Router {...props} />
}