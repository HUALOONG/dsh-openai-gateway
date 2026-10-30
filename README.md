# @joyin/dsh-openai-gateway

DSH 桌面版（JoyinCode）插件：把 DSH 已配置的模型以 **OpenAI 兼容 API** 暴露给第三方系统，
提供 **固定端口 9527**（可选）与 `/v1/info` 端口/状态查询。

这是原独立桥接 `joyin_llm_bridge.js`（占用固定 8799 端口、靠 Typert RPC + WebSocket 事件流派发会话）的
**进程内替代方案**。

---

## 端口：为什么需要「固定端口别名」

JoyinCode 启动 dsh 时**硬编码** `--port 0`（`main.js:8170`），由操作系统随机分配端口，
每次重启都会变（实测 57818 → 64712 → 63387 → 61890）。而 WorkBuddy 等第三方工具的
`baseURL` 是静态配置 —— 端口一变就失效。

**DSH 本身支持 `--port`**（`dsh --profile web --port 9527`），也存在官方的反向代理机制
（`--public-url` + `--trusted-host`）。但这两种方式都需要修改 JoyinCode 的 spawn 参数，
而 `main.js` 打包在 `app.asar` 内、受签名保护，改动会在升级后丢失。

因此本插件采用第三种方式：**在进程内再监听一个固定端口**（默认 9527），与 DSH 动态端口
共享同一套 handler。这是在 HTTP 层复用而非 TCP 转发，所以：

- 无需知道 DSH 当前端口，不依赖端口探测；
- 没有额外网络跳数、没有 Host/authority 校验问题；
- DSH 重启后外部配置无需改动。

```
第三方工具 ──► 127.0.0.1:9527  ─┐
                                ├─► 同一套 /v1/* handler ─► DSH provider ─► 计算代理
DSH 自身   ──► 127.0.0.1:61890 ─┘
```

端口可在 `cordis.patch.yml` 的 `config.fixedPort` 修改；设为 `0` 则关闭别名，
退化为仅使用 DSH 动态端口。若端口被其它程序占用，别名会自动降级为 `occupied`
状态并在 `/v1/info` 中标注，DSH 端口路由不受影响。

> **为什么不用 TCP 转发整个 DSH 服务（含 Web UI）？**
> DSH 的 `/api` 有 browser-trust 校验，且 `dsh-auth` cookie 名称由 authority
> （`sha256(host:port)`）派生。把整个服务透明转发到另一个端口会导致 authority 不匹配、
> 登录态失效。官方解法是 `--public-url` + `--trusted-host`，需要改 spawn 参数，
> 不可持久化。所以本插件只固定 **API 端口**，不动 Web UI。

---

## 为什么改成插件

| 维度 | 独立桥接（旧） | DSH 插件（本方案） |
|---|---|---|
| 运行位置 | DSH 进程外，独立 8799 端口 | DSH 进程内，挂宿主 WebServer |
| 对外地址 | 固定 8799，但需探测 DSH 端口 | **固定 9527**，无需探测 |
| 取模型/凭据 | 自行解密 auth.json、伪造 cookie | 直接复用宿主 `llm` / `credentials` 服务 |
| 请求路径 | 建会话 → 发 prompt → 订阅事件流 | 直接转发到宿主已配置的上游 provider |
| 故障面 | 端口漂移、cookie 过期、轮询截断 | 随 DSH 启动自动加载 |
| 生命周期 | 需守护进程 | `dsh plugin add` / `remove` |

旧桥接的两个历史问题（`fetch failed`、回复被截断成 120 字）在本方案里**结构上不存在**。

---

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/v1/chat/completions` | Bearer 网关密钥 | OpenAI 兼容补全，支持 `stream: true` |
| GET | `/v1/models` | Bearer 网关密钥 | 列出 DSH 当前可用模型（走 `llm` seam） |
| GET | `/v1/info` | 本机免鉴权 / 跨机需密钥 | 端口、baseURL、模型数、运行时长 |
| POST | `/v1/keys` | 仅本机 | 创建网关密钥（明文只返回一次） |
| GET | `/v1/keys` | 仅本机 | 列出密钥（不含明文） |
| DELETE | `/v1/keys?id=<id>` | 仅本机 | 吊销密钥 |

`/v1/info` 关键字段：

```json
{
  "plugin": { "name": "@joyin/dsh-openai-gateway", "version": "0.1.0" },
  "listening": {
    "protocol": "http", "host": "127.0.0.1", "port": 61890,
    "baseURL": "http://127.0.0.1:61890/v1"
  },
  "alias": {
    "enabled": true, "port": 9527, "status": "listening",
    "baseURL": "http://127.0.0.1:9527/v1"
  },
  "recommendedBaseURL": "http://127.0.0.1:9527/v1",
  "models": { "total": 7, "providers": { "deepseek-official": 7 } },
  "runtime": { "pid": 27520, "uptimeSeconds": 128 }
}
```

`recommendedBaseURL` 在别名就绪时指向固定端口，否则回退到 DSH 动态端口 —— 直接用它即可。

---

## 安装 / 卸载

插件位于 `C:\Users\Joyin\dsh-openai-gateway`：

```bash
cd C:\Users\Joyin\dsh-openai-gateway

node manage.mjs install      # 安装到当前账号的 web profile，并自动加入 dsh.profile.bundles
node manage.mjs uninstall    # 卸载
node manage.mjs update       # 更新（本地路径插件等同重装）
node manage.mjs status       # 安装状态 + 是否已激活 + 运行中端口
node manage.mjs info         # 打印固定端口/DSH 端口、模型、端点
node manage.mjs sync         # 把端口/密钥/模型写进 WorkBuddy 的 models.json（可选）
```

**安装后需重启 JoyinCode 桌面应用**才会加载。

`manage.mjs` 会自动探测 DSH 账号目录（`%APPDATA%\@joyin\joyin-worker\dsh\accounts\<hash>`）
与运行时目录（优先从运行中的 dsh 进程命令行反推）。探测不准时手工指定：

```bash
node manage.mjs install \
  --dsh-home "%APPDATA%\@joyin\joyin-worker\dsh\accounts\<hash>" \
  --runtime-root "D:\...\JoyinCode\resources\dist\runtime"
```

卸载失败提示 profile 被占用时，**完全退出 JoyinCode**（含托盘）后重试。

---

## 查看监听端口

三种方式：

1. **固定端口**（最常用）—— `curl http://127.0.0.1:9527/v1/info`
2. **命令行** —— `node manage.mjs info`（先探测 9527，失败再扫描动态端口）
3. **插件日志** —— DSH 启动日志会打印
   `[dsh-openai-gateway] 固定端口已就绪：http://127.0.0.1:9527/v1`

---

## 第三方调用

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:9527/v1",   // 固定，无需跟随 DSH 重启
  apiKey: "<网关密钥>",                   // 来自 POST /v1/keys
});

const r = await client.chat.completions.create({
  model: "deepseek-v4.1-flash",
  messages: [{ role: "user", content: "你好" }],
});
```

创建密钥：

```bash
curl -X POST http://127.0.0.1:9527/v1/keys \
  -H "Content-Type: application/json" \
  -d '{"label":"workbuddy"}'
```

密钥只存 SHA-256 哈希于 DSH `credentials`（ref: `joyin_openai_gateway_keys`），明文仅创建时返回一次。
使用独立 ref 名是为了不与 `@joyin/dsh-model-gateway` 的 `dsh_gateway_keys` 冲突。

---

## 与 WorkBuddy 联动

```bash
node manage.mjs sync             # 实际写入（自动备份 models.json）
node manage.mjs sync --dry-run   # 只预览不改动
```

行为：

- 复用 `models.json` 里已有的网关密钥；失效则新建一个
- 删除旧的 `_source: "dsh-openai-gateway"` / `vendor: "JoyinCode"` 条目，按 `/v1/models` 重建
  （带 `maxInputTokens` / `maxOutputTokens`，来自 JoyinCode 注入的模型目录）
- 保留其它 Custom 模型不动
- 写入前备份为 `models.json.bak-<时间戳>`

**固定端口启用后，只需 sync 一次**，JoyinCode 重启无需重跑。

---

## 实现要点

- **插件契约**：`export function apply(ctx, config)`（Cordis），`ctx.inject(["webServer","settings","credentials","llm"], ...)`，
  `webCtx.webServer.register({ kind: "exact", path, handler })`。
- **加载机制**：`package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，
  该 patch 用 `insert` 把插件加入插件树；`dsh plugin add` 会自动把包名追加进
  `profiles/web` 的 `dsh.profile.bundles`。
  **没有 `dsh.bundle.patch` 的包即使装进 profile 也不会被加载。**
- **固定端口实现**：插件内部 `http.createServer()` 监听 `127.0.0.1:<fixedPort>`，
  按 path 分发到同一批 handler（`Map<path, handler>`），与 DSH WebServer 完全共用逻辑。
- **模型来源**：`llm.listProviders()` + `llm.listModels(id)`；上下文/输出上限由
  `JOYIN_WORKER_MODELS_JSON` 补齐（宿主 seam 未返回这两项）。
- **provider 来源**：平台 provider `deepseek-official` 从进程环境重建 —— JoyinCode 注入
  `DEEPSEEK_BASE_URL`（本地签名代理）、`DEEPSEEK_API_KEY`、`JOYIN_WORKER_MODELS_JSON`；
  自定义 provider 从 `configEditor` 读 `llm-pi-ai` 运行时配置（best-effort）。
- **上游转发**：按 provider 家族构造请求 —— `openai-compatible` / `workbuddy`；
  `anthropic` 通道暂未内置（返回 501）。

---

## 验证

```bash
node test/smoke.mjs
```

用模拟 DSH 上下文（真实 HTTP server + 假 credentials/llm + 假上游）跑 **33 项断言**：
路由注册、`/v1/info` 端口、免鉴权/401、密钥创建与吊销、模型枚举、非流式与流式转发、
未知模型 404、不泄露上游凭据、**固定端口别名（创建密钥+补全+未知路径）**、
**端口被占用时降级为 occupied 且回退到 DSH 端口**。

结果：**33/33 通过**。

真实宿主验证（2026-10-30）：

- `dsh --profile web --dump-config` 组合出的插件树包含 `fixedPort: 9527`，patch 解析无误；
- 真实 DSH 进程（PID 27520）同时监听 `61890`（动态）与 `9527`（别名）；
- `GET 9527/v1/models` 返回 7 个平台模型；
- `POST 9527/v1/chat/completions`（`deepseek-v4.1-flash`）返回
  `1+1等于2。`，`finish_reason: stop`，`usage.total_tokens: 84`。

---

## 排查

| 现象 | 处理 |
|---|---|
| `manage.mjs info` 报"未发现运行中的插件实例" | 确认已 `install` 且**重启过** JoyinCode；`status` 看 bundle 是否激活 |
| 9527 被其它程序占用 | 改 `cordis.patch.yml` 的 `config.fixedPort`，重装后重启；`/v1/info` 的 `alias.status` 会显示 `occupied` |
| install 报 profile 被占用 | 完全退出 JoyinCode 后重试 |
| `401 无效或缺失的网关 API Key` | 用 `POST /v1/keys` 新建；或 `manage.mjs sync` 自动处理 |
| `/v1/chat/completions` 报"未找到模型 x 的 provider" | `GET /v1/models` 看真实可用 id |
| 上游 `HTTP 403` 含"请升级" | JoyinCode 客户端版本过低，升级后重启 |

---

MIT © JoyinCode
