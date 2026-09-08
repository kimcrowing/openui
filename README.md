# OpenCode Web UI (overlay for official packages/app, V2)

基于 **官方 opencode V2 web UI（上游 `anomalyco/opencode` `v2` 分支的 `packages/app`）** 的定制覆盖层：
保持官方 V2 布局不变，做最小必要适配，解决 **GitHub Pages 静态部署（子路径 `/openui/`）** 的独有痛点。

- 源码基线：上游 **`v2` 分支**（官方 V2 真身。`packages/app` 用 vite 8.2.2 / rolldown 后端，
  产物为 `_assets/` 多 chunk + `rolldown-runtime`，与本机 `opencode2` 内嵌 UI 完全同源）。
  - **更正（2026-09-08，实测）**：曾误用上游 `dev` 分支构建（dev = V1 维护线，`packages/opencode`
    version 1.18.29、vite 7.1.4/rollup 后端），产物形态与官方 V2 不符（用户指出「接入的不是 v2」）。
    已切换基线至 `v2` 分支并按新基线重做全部覆盖文件。
  - **更正（2026-09-08，实测）**：V2 服务端（本机 `opencode2 serve :4096` 实测）HTTP API 为**根路径风格**——
    `/session`、`/config`、`/event`、`/health` 均返回 200（无 `/api` 前缀）；`/api/*` 仅用于
    control / 集成 / 权限等少量端点。曾误写为「已完成 `/api/*` V2 HTTP 接口迁移」，已更正。
- 本仓库 `webui-src/packages/app/` **只保留覆盖文件**，完整 `packages/app` 由 CI 从上游 clone。
- 构建与发布：**GitHub Actions**（无需本机安装 bun / node）。
- 产物地址：`https://kimcrowing.github.io/openui/`

---

## 一、怎么跑起来（连接一个 V2 opencode 服务端）

app 通过 **V2 服务端**（`opencode2`）连接。默认服务器地址在构建时注入
`VITE_DEFAULT_SERVER_URL`（见 workflow env），页面打开即自动连接；也支持在
设置里添加/切换多个 server。

```bash
# 本地起 V2 服务端（放行公网 Pages 源）
opencode2 serve --cors "https://kimcrowing.github.io" \
                --cors "http://localhost:*"
# 或运行时设置 CORS 列表：
#   opencode2 service set cors "https://kimcrowing.github.io, http://localhost:*"
```

页面打开后：右上角 **Servers / Settings** → Add server，填写
`http://127.0.0.1:4096`（或公网 HTTPS 反代地址）。若服务端启用了鉴权，app 支持
通过 URL 参数 `?auth_token=<token>` 注入 Bearer token（进入页面后会自动从地址栏移除）。

> 已知安全边界：浏览器从**公网 https 页面**直接 fetch **内网/回环 server** 会被
> Chrome Private Network Access 拦截（V1/V2 均受限）；要在公网使用，需给
> server 配公网 HTTPS 反代，或在本地/同源环境使用。

---

## 二、GitHub Actions 构建 + 部署

`.github/workflows/build-webui.yml`：

1. **Clone 官方 monorepo** `anomalyco/opencode @ v2`（默认；workflow_dispatch 可填
   branch / tag / commit SHA，如 `upstream_ref: dev` 或某个 commit）
2. **合并覆盖**：把 `webui-src/packages/app/` 的覆盖文件 `cp` 进上游完整
   `packages/app`（其余文件、`package.json`、workspace 依赖均由上游提供）
3. **setup-bun**（官方 build 固定 `bun@1.3.14`）→ `bun install --ignore-scripts --frozen-lockfile`
4. `bun run build`（vite 8.2.2 rolldown；带 `VITE_BASE=/openui/`，适配 Pages 子路径）
5. `dist/index.html` 复制为 `dist/404.html`（GitHub Pages SPA history 回退）
6. `configure-pages` + `upload-pages-artifact` + `deploy-pages`

> workflow `workflow_dispatch` 可指定 `upstream_ref`（默认 `v2`）重新基于上游构建。
> 注意：`v2` 分支随上游持续迭代，覆盖文件与上游契约若有出入，CI 构建会失败并给出
> 编译错误（fail loudly），届时按报错更新覆盖文件即可。
> 历史结论：`dev`/`production` 分支是 **V1 维护线**；`2.0` 分支是 2026-04 停更的
> 早期探索分支（version 1.4.3）——均不是 V2 真身，勿再作为基线。

---

## 三、我们对官方源码的改动（overlay 覆盖文件）

覆盖文件全部位于 `webui-src/packages/app/`，为**最小必要适配**（保留官方 V2 布局）：

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `vite.config.ts` | 增加 `base: process.env.VITE_BASE \|\| "/"`、`sourcemap: false`；**移除 `serviceWorker`（vite.pwa）插件** | 默认 `/` 保持官方行为；Pages 子路径设 `/openui/`；上游 SW 的 `navigateFallback` 是根路径锚定，子路径下破坏刷新，故本部署不用 SW（SPA fallback 交给 404.html） |
| `vite.icons.ts` | 所有 URL 引用加 `VITE_BASE` 前缀（favicon/apple-touch/manifest icons 及 `start_url`/`scope`/`id`） | 官方输出 `/icons/dev/favicon.ico`、`/site.webmanifest` 等根路径锚定，子路径下 404 |
| `index.html` | `<link rel="manifest">`、og/twitter image 改用 `%BASE%` 占位符（vite 内建 env 替换） | 页面内根路径资源在子路径部署下的适配 |
| `src/app.tsx` | 默认 Router 注入 `base={import.meta.env.BASE_URL}`（`PrefixedRouter`；调用方仍可用 `router` prop 覆盖） | 官方路由 `"/"`、`"/server/:key/session/:id"` 等自动前缀部署子路径，SPA 刷新可命中 |
| `src/entry.tsx` | service worker 注册路径改 `import.meta.env.BASE_URL + "sw.js"` 并 `.catch` 静默（本部署无 SW） | 避免子路径下 `register("/sw.js")` 404 产生的 unhandled rejection |
| `src/runtime/platform/web.ts` | `getCurrentServerUrl()` 优先取 `import.meta.env.VITE_DEFAULT_SERVER_URL` | 官方生产环境回退 `location.origin`（部署站自身），静态部署无同源后端必须注入真实 API 地址 |

> 覆盖文件是「基于上游 v2 某一时刻的完整文件 + 补丁」的成品，CI 用 `cp` 合并覆盖（而非
> patch），对上游文件的漂移容忍度更高（编译失败能立刻发现）。升级/同步上游时只需
> 重新取 v2 对应文件重打补丁。

---

## 四、目录结构

```
.
├── .github/workflows/build-webui.yml   # 构建+部署 Pages（clone 上游 v2 + 合并覆盖）
├── legacy-static/                      # 旧 V1 自建版（纯静态 HTML/CSS/JS），保留作参考
└── webui-src/packages/app/             # 仅覆盖文件（完整 app 由 CI 从上游 v2 提供）
    ├── vite.config.ts                  # VITE_BASE / sourcemap / 移除 serviceWorker
    ├── vite.icons.ts                   # 图标/manifest URL 前缀 VITE_BASE
    ├── index.html                      # %BASE% 处理 manifest / og 占位符
    └── src/
        ├── app.tsx                     # 默认 Router 注入 base（PrefixedRouter）
        ├── entry.tsx                   # SW 注册 base 化 + 防 404
        └── runtime/platform/web.ts     # VITE_DEFAULT_SERVER_URL（生产默认 API 地址）
```