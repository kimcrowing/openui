# OpenCode Web UI (overlay for official packages/app, V2)

基于 **官方 opencode V2 web UI（上游 `anomalyco/opencode` `dev` 分支的 `packages/app`）** 的定制覆盖层：
保持官方 V2 布局不变，做最小必要适配，解决 **GitHub Pages 静态部署（子路径 `/openui/`）** 的独有痛点。

- 源码基线：上游 `dev` 分支（官方 V2 web UI，纯静态 `dist/` 产物）。
  - **更正（2026-09-08，实测）**：V2 服务端（本机 `opencode2 serve :4096` 实测）HTTP API 为**根路径风格**——`/session`、`/config`、`/event`、`/health` 均返回 200（无 `/api` 前缀）；`/api/*` 仅用于 control / 集成 / 权限等少量端点（v2 SDK `sdk.gen.ts` 中 `/api/session`、`/api/pty`、`/api/credential` 等就是这类）。曾误写为「已完成 `/api/*` V2 HTTP 接口迁移」，已更正。
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

1. **Clone 官方 monorepo** `anomalyco/opencode @ dev`（默认；workflow_dispatch 可填
   branch / tag / commit SHA，如 `upstream_ref: v1.18.29` 或某个 commit）
2. **合并覆盖**：把 `webui-src/packages/app/` 的覆盖文件 `cp` 进上游完整
   `packages/app`（其余文件、`package.json`、vendor tgz、workspace 依赖均由上游提供）
3. **setup-bun**（官方 build 固定 `bun@1.3.14`）→ `bun install --ignore-scripts --frozen-lockfile`
4. `bun run build`（带 `VITE_BASE=/openui/`，适配 Pages 子路径）
5. `dist/index.html` 复制为 `dist/404.html`（GitHub Pages SPA history 回退）
6. `configure-pages` + `upload-pages-artifact` + `deploy-pages`

> workflow `workflow_dispatch` 可指定 `upstream_ref`（默认 `dev`）重新基于上游构建。
> 注意：`dev` 分支无稳定标签、随上游持续迭代，覆盖文件与上游契约若有出入，CI 构建
> 会失败并给出编译错误（fail loudly），届时按报错更新覆盖文件即可。

---

## 三、我们对官方源码的改动（overlay 覆盖文件）

覆盖文件全部位于 `webui-src/packages/app/`，为**最小必要适配**（保留官方 V2 布局）：

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `vite.config.ts` | 增加 `base: process.env.VITE_BASE \|\| "/"`、`sourcemap: false`、`cssCodeSplit`、`minify: esbuild` | 默认 `/` 保持官方行为；Pages 子路径设 `/openui/`；纯静态部署关闭 sourcemap |
| `src/entry.tsx` | `isSubPathDeployment()`：子路径部署时不再把静态源当 server，改用 `VITE_DEFAULT_SERVER_URL`；`server` 无 URL 时不提供；注入自定义 `router={PrefixedRouterRoot}` | Pages 子路径无同源后端，`location.origin` 会 404 |
| `src/router/prefixed-router.tsx` | 新增：`@solidjs/router` 0.15.4 的 `createRouter` 包装，在 history 边界剥/加 `/openui` 前缀 | 官方源码内的路由比较基于干净路径，避免子路径前缀破坏 `=== "/new-session"` 等精确逻辑 |
| `src/components/titlebar.tsx` | `ChannelIndicator` 返回 `null`（隐藏 DEV/BETA 徽标） | channel env 仍用于新布局等逻辑，仅去掉可见标记 |
| `src/index.css` | 两个 `@font-face` 加 `font-display: swap`；末尾追加 `@layer base` 渲染优化（抗锯齿 / overscroll / tap-highlight / selection / reduced-motion） | 纯 CSS 优化，不影响布局 |

> 覆盖文件是「基于上游 dev 某一时刻的完整文件 + 补丁」的成品，CI 用 `cp` 合并覆盖（而非
> patch），对上游文件的漂移容忍度更高（编译失败能立刻发现）。升级/同步上游时只需
> 重新取 dev 对应文件重打补丁。

---

## 四、目录结构

```
.
├── .github/workflows/build-webui.yml   # 构建+部署 Pages（clone 上游 dev + 合并覆盖）
├── legacy-static/                      # 旧 V1 自建版（纯静态 HTML/CSS/JS），保留作参考
└── webui-src/packages/app/             # 仅覆盖文件（完整 app 由 CI 从上游 dev 提供）
    ├── vite.config.ts                  # VITE_BASE / sourcemap / minify 适配
    └── src/
        ├── entry.tsx                   # 子路径部署的默认 server 与 router 注入
        ├── index.css                   # font-display + @layer base 渲染优化
        ├── components/titlebar.tsx     # 隐藏 channel 徽标
        └── router/prefixed-router.tsx  # 子路径 history 路由（@solidjs/router 0.15.4）
```