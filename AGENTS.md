# openui 项目（GitHub Pages 静态部署官方 V2 web UI）

本文件记录本项目专属结论；通用（termux/网络/代理等）见
`~/.config/opencode/AGENTS.md`。本仓库：`kimcrowing/openui`（fork 自 anomalyco/opencode 的
overlay 仓库，CI 从上游 clone 后合并覆盖构建部署到 GitHub Pages `/openui/`）。

## 一、上游分支图谱（2026-09-08 实测定案，决定一切基线选择）

- **`v2` 分支 = V2 主线（本项目的正确基线）**：
  - `packages/opencode` 不存在（当时叫 `packages/cli`）；版本 v0.0.0 系（未发布预发布）。
  - `packages/app`：`vite@8.2.2`（devDependencies 直接版本，**不是 catalog**）、
    `@solidjs/router@1.0.0`（catalog）、`tailwindcss@4.3.3`、`@opencode/*`（workspace scope）。
  - **vite 8.2.2 = rolldown 后端**（npm 依赖 `rolldown ~1.2.4`）；vite.config.ts 显式
    `assetsDir: "_assets"` → 产物 `/_assets/` 多 chunk + `rolldown-runtime-*.js`（非 `/assets/` 单 chunk）。
  - 路由形态：`/`、`/settings`、`/new-session`、**`/server/:serverKey/session/:id`**；
    根路径 API 契约（dc /session、/config、/event、/health；/api/* 仅 control/集成/权限）。
  - 活跃：最近 commit 每天都有（如 2026-09-07~08 的 cli 发布/AUR/Cloudflare 等）。
- **`dev` 分支 / `production` 分支 = V1 维护线（勿用作 V2 基线）**：
  - `packages/opencode` 存在，version 1.18.29、bin `opencode`；`packages/app` 用 `vite: catalog:`（=7.1.4，
    **rollup 后端**，产物 `/assets/` 单 chunk）；路由不含 `/server/` 前缀。
  - 曾因误用 dev 构建导致 UI 非 V2 形态（用户实测反馈「接入的不是 v2」）。
- **`2.0` 分支 = 2026-04-13 停更的早期探索分支**（version 1.4.3、`--background-base` 旧样式变量），勿用。
- 验证工具链（实测有效）：
  - 本机 `opencode2/bin/.built-sha` 记录二进制构建 sha（如 b2cecc6）→
    `GET /repos/anomalyco/opencode/compare/<branch>...<sha>`：`behind` 且 `ahead=0` ⇒ 该 sha 在分支祖先链上。
  - `git ls-remote https://github.com/anomalyco/opencode.git`（走 7890 代理）比 GitHub API 分页快得多。
  - npm registry：`vite/8.2.2` 依赖里出现 `rolldown` = vite8（rolldown 后端）；vite7.x 依赖 `rollup`。

## 二、本项目构建链（workflow build-webui.yml）

1. checkout 本仓库（overlay 源）→ clone 上游 + `fetch --depth 1 origin v2` + checkout FETCH_HEAD。
2. 合并覆盖：`webui-src/packages/app/` 的文件 `cp -a` 进上游 `packages/app/`（其余文件由上游提供）。
3. `bun install --ignore-scripts --frozen-lockfile`（v2 分支 bun.lock：vite 8.2.2 + rolldown + workspace
   `@opencode/*` + `ghostty-web` git 依赖）。
4. `bun run build`（packages/app，vite 8.2.2 rolldown；env `VITE_BASE=/openui/`、
   `VITE_DEFAULT_SERVER_URL=https://kimcrowing.dynv6.net:14096`）。
5. `dist/index.html` 复制为 `dist/404.html`（GitHub Pages SPA history 兜底）。
6. `configure-pages` / upload / deploy。

## 三、overlay 覆盖文件（webui-src/packages/app/，基于 v2 分支基线）

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `vite.config.ts` | `base: process.env.VITE_BASE ?? "/"`；`sourcemap:false`；**移除 serviceWorker(vite.pwa) 插件** | 上游 SW `navigateFallback` 根路径锚定，子路径下破坏刷新；SPA 交给 404.html |
| `vite.icons.ts` | 所有 URL 加 `VITE_BASE` 前缀（favicon/apple-touch/manifest icons + start_url/scope/id）；transformIndexHtml 里 `replaceAll("%BASE%", base)` | 根路径锚定资源子路径 404；**vite 8 实测不替换 html 里的 %BASE%**（%OPENCODE_* 由本插件替换） |
| `index.html` | manifest/og 用 `%BASE%` 占位（由 vite.icons.ts 替换） | 同 v2 index.html 其余不动 |
| `src/app.tsx` | 默认 Router 用 `PrefixedRouter`（`@/router/prefixed-router`，router prop 仍可覆盖） | 子路径 history 路由 |
| `src/router/prefixed-router.tsx` | **V2 化专用 Router**：不给 solid-router 传 base，`createRouter` integration 在 history 边界做前缀转换（get 剥 / set 加 `/openui`） | 见第四节根因实证 |
| `src/entry.tsx` | SW 注册 `import.meta.env.BASE_URL + "sw.js"` + `.catch(()=>{})` | 本部署无 SW，防 404 unhandled rejection |
| `src/runtime/platform/web.ts` | `getCurrentServerUrl()` 优先 `VITE_DEFAULT_SERVER_URL` | 官方生产回退 `location.origin`（部署站自身），静态部署必须注入真实 API 地址 |
| `src/runtime/i18n/zh.ts` | **完整覆盖**（基于 v2 分支基线，补全 241 个缺失 key 的中文翻译） | 设置页等大量汉化不全；overlay 是整文件覆盖，上游更新 en.ts 后需重新 diff 对齐 |

- **历史教训：曾给 `<Router base>` 传 vite base 导致线上 ErrorBoundary（2026-09-08 修复，见第四节）。
  正确方案是 history 边界转换，不是 base prop。**
- 曾用 dev 基线的旧文件已删除：`src/components/titlebar.tsx`、`src/index.css`、`webui-src/packages/app/src/router/prefixed-router.tsx`
  （dev 线 solid-router 0.x 版）。V2 线的 `src/router/prefixed-router.tsx` 是 2026-09-08 新建（solid-router 1.0.0 API）。
- 本地工作分支 `upgrade-v2`（推送目标 `origin main`；**push 必须 `git push origin upgrade-v2:main`**，
  本地 `main` 引用可能陈旧——见全局 AGENTS.md 的 git 分支事故教训）。

## 四、关键坑（实测）

- **子路径部署绝对禁止给 solid-router 传 `base` prop（2026-09-08 实证）**：
  - solid-router 1.0.0 的 `base` 只把前缀拼进 route pattern（匹配/导航），**不会从
    `useLocation().pathname` 剥离前缀** → `location.pathname` 带 `/openui`。
  - 应用代码用精确比较解析 pathname：`shell/state/layout.tsx` 的 `currentRoute()`
    （`parts[0] === "settings"/"new-session"/"server"`）→ `parts[0]="openui"` 全部落空 →
    抛 Unrecognised route → SettingsSurface `layout.route().type`（无 `??` 兜底）→
    `TypeError: Cannot read properties of undefined (reading 'type')` → ErrorBoundary。
  - 实证链：① 线上 Error Details（textarea）堆栈 `surface-*.js active` →
    ② 反混淆定位 `settings/surface.tsx` `open = () => layout.route().type === "settings"` →
    ③ 本地同 dist 对照实验（chromium headless）：serve 在 `/openui/` 报错、去掉前缀 serve 在根路径正常 →
    ④ solid-router 1.0.0 官方源码（npm tarball dist/routing.js `createRouterContext`）确认 base 不进 location。
  - **修复（`src/router/prefixed-router.tsx`）**：不给 Router 传 base（内部路径保持干净），
    `createRouter({get,set,init,create,utils})` integration 在 history 边界转换——
    `get()`（初始/popstate）剥 `BASE_ROOT` 前缀、`set()`（push/replaceState）加回前缀；
    anchor 点击按官方 `setupNativeEvents` 语义复刻（同源/无修饰键/download/external 过滤，
    未从包导出故手写）。官方 `createRouter` 组件 API：`createRouter(config)` 返回组件接收
    `BaseRouterProps`（root/children…）；`utils:{go,beforeLeave}`；`navigatorFactory(router.base)`。
  - 验证（线上实测通过）：首页渲染 `Projects/Add project/Loading/Settings/Help`；直接加载
    `/openui/settings`（404.html 兜底 + stripBase）；点击侧栏 Settings → URL 写回 `/openui/settings`
    （addBase）；全程无 ErrorBoundary。
  - 对照本机官方 opencode2（localhost:4096，base="/"）渲染一致。
  - commit `53ddcdd`（upgrade-v2 → origin main），CI run `34178941398` success。
- **vite 8（rolldown）html 里 `%BASE%` 不会自动替换**（vite 7 行为？未知）：需在 transformIndexHtml
  插件手动 `replaceAll("%BASE%", base)`。
- vite build 传 `base=/openui/` 后：`assetsDir:"_assets"` 产物在 `/openui/_assets/`，
  `public/` 文件与插件 `emitFile` 产物在 `/openui/*`（icons 插件 emit `icons/dev/*`、`site.webmanifest`）。
- 线上验证要点：`<link rel="manifest" href="/openui/site.webmanifest">`、`/openui/icons/dev/favicon.ico` 200、
  index.html 引 `/_assets/rolldown-runtime-*.js`（V2 形态判据：rolldown 多 chunk；V1 是 `/assets/` 单 chunk）。
- 本机 opencode2 内嵌 UI 与其构建 sha 一致时，asset 文件名可逐项对照（如 `rolldown-runtime-hePW80VL.js`、
  `session-progress-indicator-v2-*`、`desktop-native-*`、`web-XmjmRCpJ.js`）。

## 五、产物与部署

- Pages 地址：`https://kimcrowing.github.io/openui/`（VITE_DEFAULT_SERVER_URL → 本机 dynv6 opencode2）。
- CI 触发：push `webui-src/**` 或 workflow 文件；也可 workflow_dispatch 指定 `upstream_ref`。
- 缓存 key：`${{ runner.os }}-bun-v2-${{ env.UPSTREAM_REF }}-${{ hashFiles('webui-src/**') }}`。

- **中文 i18n 补齐（2026-09-08 交付，commit `e63d73b`，CI run `34180037808` success）**：
  - 基线对照法：`en.ts`（1219 key）vs `zh.ts`（1068 key）差 241 个缺失 key → 全部补齐。
  - 校验手段（本机 node+typescript@5.6）：`ts.transpileModule` 语法通过；无重复 key；
    所有 `{{变量}}` 插值与 en.ts 一一对应（自动脚本核对，0 不一致）。
  - **验证要点（chromium headless，必须 `--lang=zh-CN --accept-lang=zh-CN,zh`）**：
    不传语言参数时 `navigator.language` 恒为 en-US，UI 全英文——这是**语言检测**问题不是翻译缺失！
    桌面视口（`--window-size=1400,900`）下设置侧栏 12 个 tab（偏好/外观/通知/快捷键/服务器/项目/
    工作树/提供商/模型/扩展/实验功能/关于）全部中文；工作树/通知/关于子页正文全部中文。
  - 侧栏"只剩 2 项"是**小视口触发布局切换**（桌面侧栏 CSS 隐藏、只剩移动导航）的假象，非翻译问题。
  - overlay 是整文件覆盖：上游更新 en.ts 后需重跑 diff 补全。
