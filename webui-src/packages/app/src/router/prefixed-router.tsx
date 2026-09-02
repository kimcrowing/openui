import { onCleanup } from "solid-js"
import {
  createRouter,
  createBeforeLeave,
  keepDepth,
  saveCurrentDepth,
  notifyIfNotBlocked,
  type BaseRouterProps,
} from "@solidjs/router"

// GitHub Pages 子路径部署（Vite base "/openui/"）专用 Router。
// 原则：路由内部一律使用“干净”路径（默认 base=""，如 "/new-session"），
// 这样 useLocation().pathname / useHref / navigate 目标都与官方源码保持一致。
// 只在 history 边界做前缀转换：
//   - get  （读 window 路径）时剥掉 "/openui" 前缀；
//   - set  （写 history）时加回 "/openui" 前缀。
// 由此避免把 base 传给 Router 导致 location.pathname 带前缀、破坏官方代码里
// `=== "/new-session"` 等精确比较与占位/滚动逻辑。
const BASE_ROOT = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "")

function stripBase(pathname: string) {
  if (!BASE_ROOT) return pathname
  if (pathname === BASE_ROOT || pathname === `${BASE_ROOT}/`) return "/"
  if (pathname.startsWith(`${BASE_ROOT}/`)) return pathname.slice(BASE_ROOT.length)
  return pathname
}

function addBase(value: string) {
  if (!BASE_ROOT || !value.startsWith("/")) return value
  if (value === "/") return `${BASE_ROOT}/`
  if (value.startsWith(`${BASE_ROOT}/`)) return value
  return `${BASE_ROOT}${value}`
}

function scrollToHash(hash: string, fallbackTop?: boolean) {
  const el = hash && document.getElementById(hash)
  if (el) {
    el.scrollIntoView()
  } else if (fallbackTop) {
    window.scrollTo(0, 0)
  }
}

export function PrefixedRouterRoot(props: BaseRouterProps) {
  const getSource = () => {
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
    create: (router) => {
      const navigateFromRoute = router.navigatorFactory(router.base)
      function handleAnchor(evt: MouseEvent) {
        if (
          evt.defaultPrevented ||
          evt.button !== 0 ||
          evt.metaKey ||
          evt.altKey ||
          evt.ctrlKey ||
          evt.shiftKey
        ) {
          return
        }
        const a = evt
          .composedPath()
          .find((el) => el instanceof Node && el.nodeName.toUpperCase() === "A") as
          | HTMLAnchorElement
          | undefined
        if (!a) return
        const target = a.target
        if (target || (!a.href && !a.hasAttribute("state"))) return
        const rel = (a.getAttribute("rel") || "").split(/\s+/)
        if (a.hasAttribute("download") || rel.includes("external")) return
        const url = new URL(a.href)
        if (url.origin !== window.location.origin) return
        return [a, url] as const
      }
      function handleAnchorClick(evt: MouseEvent) {
        const res = handleAnchor(evt)
        if (!res) return
        const [a, url] = res
        const to = router.parsePath(url.pathname + url.search + url.hash)
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