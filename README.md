# OpenCode Web

现代化的 **OpenCode 网页前端**，纯静态站点，可直接部署到 GitHub Pages。
界面参考 ChatGPT / Grok，支持手机与桌面，**内置 11 套配色主题**。

无需构建、无第三方依赖 —— 只有 HTML / CSS / 原生 ES Module。

---

## 一、怎么跑起来

### 1. 启动 opencode 服务端

本前端是纯静态页面，需要连到一个正在运行的 `opencode serve`。

**关键：必须加 `--cors` 指向你的网页地址**，否则浏览器会被跨域策略拦截。

```bash
# 部署到 GitHub Pages 后（换成你自己的地址）
opencode serve --port 4096 --cors https://<你的用户名>.github.io

# 本地预览时
opencode serve --port 4096 --cors http://localhost:8000
```

若服务端设了密码（`OPENCODE_SERVER_PASSWORD`），网页里填用户名/密码即可
（走 HTTP Basic 鉴权，用户名默认 `opencode`）。

### 2. 打开网页

直接双击 `index.html` 不行（ES Module 受 `file://` 限制），
需要用一个静态服务器：

```bash
cd <本项目目录>
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

### 3. 连接

网页右上角「⚙ 服务器设置」→ 填服务器地址 → 保存并连接。
配置会存在浏览器 localStorage，下次自动重连。

---

## 二、部署到 GitHub Pages

1. 把本目录推到 GitHub 仓库
2. 仓库 **Settings → Pages → Source** 选 `Deploy from a branch`
3. 分支选 `main`（或 `gh-pages`），目录选 `/ (root)`
4. 保存后稍等即可访问

> 仓库里已含 `404.html`，用于客户端路由回退；
> 若用 Actions 部署，建议加 `.nojekyll` 避免 Jekyll 忽略下划线开头的文件。

---

## 三、功能

- **会话管理**：新建 / 切换 / 删除会话，左侧列表按更新时间排序
- **实时更新**：无密码时用 SSE（`/event`）流式接收；设了密码时自动退化为轮询
  （因为浏览器 `EventSource` 无法携带 Authorization 头）
- **消息渲染**：Markdown（标题/列表/代码/表格/引用/链接）、代码高亮
- **工具调用卡片**：可折叠，显示入参与输出，带 pending/running/completed/error 状态
- **推理过程**：可折叠的「思考过程」块
- **模型 / 代理选择**：从 `/provider` 与 `/agent` 实时拉取
- **停止生成**：生成中点击可中断
- **11 套主题**：跟随系统、浅色、深色、Dracula、Nord、One Dark、Material、
  Solarized、GitHub、Catppuccin、翠绿
- **响应式**：桌面侧栏常驻；≤768px 转为可滑出抽屉 + 遮罩

---

## 四、目录结构

```
.
├── index.html          # 单页应用骨架
├── 404.html            # GitHub Pages 路由回退
├── css/
│   ├── themes.css      # 11 套主题（CSS 变量，[data-theme] 切换）
│   ├── base.css        # 重置、排版、滚动条
│   └── app.css         # 布局、组件、响应式
└── js/
    ├── api.js          # opencode REST 客户端（含 Basic 鉴权）
    ├── state.js        # 极简可观察状态
    ├── markdown.js     # 轻量 Markdown + 语法高亮
    ├── messages.js     # 消息 / Part 渲染
    ├── render.js       # DOM 渲染
    ├── themes.js       # 主题管理
    └── app.js          # 入口：连接、事件、交互
```

主题通过 `<html data-theme="...">` 切换，全部颜色走 CSS 自定义属性。

---

## 五、已适配的真实 API 细节

基于本机 **opencode 1.18.25** 实测（有几个与文档不一致的地方）：

| 接口 | 注意点 |
| --- | --- |
| `GET /provider` | 返回 `{ all, default, connected }`，provider 数组在 **`all`** 里 |
| `GET /agent` | 用 **`mode: "primary" \| "subagent"`** 区分代理，**没有** `primary` 布尔字段 |
| `POST /session/:id/message` | `model` 必须是 **对象** `{ providerID, modelID }`，传字符串会 400 |
| `GET /event` | 首个事件为 `server.connected` |
| 鉴权 | HTTP Basic，用户名默认 `opencode` |
