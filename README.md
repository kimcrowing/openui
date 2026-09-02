# OpenCode Web UI (fork of official packages/app)

基于 **官方 opencode web UI（`@opencode-ai/app` v1.18.25）源码** 的定制版：
保持官方原始布局不变，做局部美化，并解决 **GitHub Pages 静态部署** 的独有痛点。

- 源码基线：`webui-src/packages/app` = 官方 `anomalyco/opencode` 仓库 `v1.18.25` 的 `packages/app`。
- 构建与发布：**GitHub Actions**（无需本机安装 bun / node）。
- 产物地址：`https://kimcrowing.github.io/openui/`

---

## 一、怎么跑起来（连接一个 opencode 服务端）

官方 app 在浏览器里通过「manage servers」添加并连接任意 `opencode serve`：

```bash
# 本地起服务端（和你网页同源约定）
opencode serve --port 4096 --hostname 127.0.0.1 \
  --cors https://kimcrowning 2>/dev/null || true
# 注意：示例里的 https://kimcrowning.github.io 需要在网页里添加为 server，
# 或本地预览时用 http://localhost:4096 走 --cors http://localhost:*
```

页面打开后：
1. 右上角 **Servers / Settings** → **Add server**
2. 填写地址（本地：`http://127.0.0.1:4096`）、用户名/密码（服务端设了
   `OPENCODE_SERVER_PASSWORD` 时为 Basic auth，用户名默认 `opencode`）
3. 设为默认，即可使用会话列表 / 新建会话 / 对话 / diff / 工具调用等官方能力

> 已知安全边界：浏览器从**公网 https 页面**直接 fetch **内网/回环 server** 会被
> Chrome Private Network Access 拦截。官方 app 与自建版都受此限制；要在公网使用，
> 需给 server 配公网 HTTPS 反代，或在本地/同源环境使用。

---

## 二、GitHub Actions 构建 + 部署

`.github/workflows/build-webui.yml`：

1. **Clone 官方仓库** `anomalyco/opencode @ v1.18.25`（app 依赖 monorepo 内的
   `@opencode-ai/{ui,sdk,schema,core,session-ui,client}` workspace 包）
2. **用 `webui-src/packages/app` 覆盖** 官方 `packages/app`（我们的改动）
3. **setup-bun**（官方 build 固定 `bun@1.3.14`）→ `bun install --ignore-scripts`
4. `bun run build`（带 `VITE_BASE=/openui/`，适配 Pages 子路径）
5. `dist/index.html` 复制为 `dist/404.html`（GitHub Pages SPA history 回退）
6. `configure-pages` + `upload-pages-artifact` + `deploy-pages`

> workflow `workflow_dispatch` 可指定 `opencode_version`（默认 `1.18.25`）重新基于上游构建。

---

## 三、我们对官方源码的改动

集中在 `webui-src/packages/app/`，目前为**最小必要适配**（保留官方布局），后续在此基础上做局部美化：

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `vite.config.ts` | 增加 `base: process.env.VITE_BASE \|\| "/"` | 默认 `/` 保持官方行为；Pages 子路径设 `/openui/` |
| `src/index.css` | 字体 `url("/assets/...")` → `url("%BASE_URL%assets/...")` | Vite 会将 `%BASE_URL%` 替换为真实 base，子路径部署字体才能加载 |

> 官方应用的「布局」定义在 `src/app.tsx`（`NewAppLayout` / `titlebar-v2` / 侧栏 /
> `NewHome` 等）与 `packages/ui`（v2 主题 token）。后续「局部美化」会追加在
> `src/index.css` 末尾的覆盖层中，不触碰组件布局。

---

## 四、目录结构

```
.
├── .github/workflows/build-webui.yml   # 构建+部署 Pages
├── legacy-static/                      # 旧自建版（纯静态 HTML/CSS/JS），保留作参考
├── webui-src/packages/app/             # 官方 packages/app 源码 + 我们的改动
│   ├── vite.config.ts                  # 加 VITE_BASE 适配子路径
│   └── src/index.css                   # 字体路径 %BASE_URL% 适配 + （规划中）美化覆盖层
```