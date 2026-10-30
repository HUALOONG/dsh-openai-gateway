// @joyin/dsh-openai-gateway
// DSH 桌面版插件：把 DSH 已配置的模型以 OpenAI 兼容 API 暴露给第三方系统，
// 并提供 /v1/info 显示实际监听端口、可用模型与运行状态。
//
// 端口策略（重要）：
//   JoyinCode 启动 dsh 时硬编码 `--port 0`（OS 随机分配），每次重启端口都变。
//   本插件因此额外提供「固定端口别名」：在插件内再监听一个固定端口（默认 9527），
//   与 DSH 动态端口共享同一套 handler。外部工具配置一次即可长期使用。
//
// 安装：node manage.mjs install
// 卸载：node manage.mjs uninstall
// 状态：node manage.mjs status
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { json, requestBody, isLocalRequest } from "./util.js";
import { createKey, listKeys, revokeKey, requireGatewayAuth, verifyKey } from "./auth.js";
import { handleChatCompletions, handleListModels, handleInfo } from "./gateway.js";
import { collectProviders, PROVIDER_IDS } from "./providers.js";

const SELF = (() => {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  } catch {
    return { name: "@joyin/dsh-openai-gateway", version: "0.0.0" };
  }
})();

const STARTED_AT = new Date().toISOString();
const DEFAULT_FIXED_PORT = 9527;

/** 本机访问或持有效密钥均可访问 /v1/info；两者都不满足则 401。 */
async function allowInfoAccess(req, res, credentials) {
  if (isLocalRequest(req)) return true;
  if (await verifyKey(credentials, req.headers.authorization)) return true;
  json(res, 401, { error: { message: "跨机访问 /v1/info 需要 Bearer 密钥" } });
  return false;
}

export const name = SELF.name;
export const inject = ["webServer"];

export function apply(ctx, config = {}) {
  const requireKeyForModels = config.requireKeyForModels !== false;
  const requireKeyForChat = config.requireKeyForChat !== false;
  const fixedPort = Number(config.fixedPort ?? DEFAULT_FIXED_PORT) || 0;

  /** 固定端口别名状态（供 /v1/info 展示）。 */
  const alias = {
    enabled: fixedPort > 0,
    port: fixedPort > 0 ? fixedPort : null,
    status: fixedPort > 0 ? "starting" : "disabled",
    baseURL: fixedPort > 0 ? `http://127.0.0.1:${fixedPort}/v1` : null,
    error: null,
  };

  ctx.inject(["webServer", "settings", "credentials", "llm"], (webCtx) => {
    const credentials = webCtx.credentials;
    const llm = webCtx.llm;

    const meta = { name: SELF.name, version: SELF.version, startedAt: STARTED_AT, alias };
    const providerSettings = () => collectProviders(webCtx);

    const chatHandler = async (req, res) => {
      if (requireKeyForChat && !(await requireGatewayAuth(credentials, req, res))) return;
      await handleChatCompletions(req, res, { settings: providerSettings(), credentials });
    };

    const modelsHandler = async (req, res) => {
      if (requireKeyForModels && !(await requireGatewayAuth(credentials, req, res))) return;
      await handleListModels(req, res, { settings: providerSettings(), llm });
    };

    const infoHandler = async (req, res) => {
      if (!(await allowInfoAccess(req, res, credentials))) return;
      await handleInfo(req, res, {
        webServer: webCtx.webServer,
        credentials,
        settings: providerSettings(),
        llm,
        meta,
      });
    };

    const keysHandler = async (req, res) => {
      // 管理面仅限本机，避免对外暴露。
      if (!isLocalRequest(req)) return json(res, 403, { error: { message: "密钥管理仅允许本机请求" } });

      if (req.method === "POST") {
        const body = await requestBody(req).catch(() => ({}));
        const key = await createKey(credentials, body?.label);
        return json(res, 200, {
          ok: true,
          key: {
            id: key.id,
            label: key.label,
            prefix: key.prefix,
            secret: key.secret,
            createdAt: key.createdAt,
          },
          note: "secret 仅此一次返回，请立即保存。",
        });
      }
      if (req.method === "GET") {
        return json(res, 200, { ok: true, keys: await listKeys(credentials) });
      }
      if (req.method === "DELETE") {
        const id = new URL(req.url, "http://127.0.0.1").searchParams.get("id");
        if (!id) return json(res, 400, { error: { message: "缺少 id" } });
        const removed = await revokeKey(credentials, id);
        return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: { message: "未找到该密钥" } });
      }
      return json(res, 405, { error: { message: "Method not allowed" } });
    };

    const routes = [
      { path: "/v1/chat/completions", handler: chatHandler },
      { path: "/v1/models", handler: modelsHandler },
      { path: "/v1/info", handler: infoHandler },
      { path: "/v1/keys", handler: keysHandler },
    ];
    const byPath = new Map(routes.map((r) => [r.path, r.handler]));

    webCtx.effect(() => {
      // 1) 挂到 DSH 自身 WebServer（动态端口）
      const disposers = routes.map((r) =>
        webCtx.webServer.register({ kind: "exact", path: r.path, handler: r.handler }),
      );

      // 2) 固定端口别名：独立 HTTP server，复用同一套 handler。
      //    这是 HTTP 层复用而非 TCP 转发，因此：无 Host/authority 校验问题、
      //    无额外网络跳数、不依赖 DSH 当前动态端口。
      let aliasServer = null;
      if (fixedPort > 0) {
        aliasServer = createServer((req, res) => {
          const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
          const handler = byPath.get(path);
          if (!handler) {
            json(res, 404, { error: { message: `Not found: ${path}` } });
            return;
          }
          Promise.resolve(handler(req, res)).catch((err) => {
            if (!res.headersSent) json(res, 500, { error: { message: err?.message ?? String(err) } });
          });
        });

        aliasServer.on("error", (err) => {
          alias.status = err?.code === "EADDRINUSE" ? "occupied" : "error";
          alias.error = err?.message ?? String(err);
          console.warn(`[dsh-openai-gateway] 固定端口 ${fixedPort} 不可用（${alias.status}）：${alias.error}`);
        });

        aliasServer.listen(fixedPort, "127.0.0.1", () => {
          alias.status = "listening";
          alias.error = null;
          console.log(`[dsh-openai-gateway] 固定端口已就绪：${alias.baseURL}`);
        });
      }

      // 启动即打印 DSH 实际端口，便于在日志里直接看到。
      try {
        const ws = webCtx.webServer;
        const port = ws?.port ?? "?";
        const host = ws?.host ?? "127.0.0.1";
        console.log(`[dsh-openai-gateway] DSH 动态端口：http://${host}:${port}/v1`);
        console.log(`[dsh-openai-gateway] 平台 provider=${PROVIDER_IDS.PLATFORM}，上游=${process.env.DEEPSEEK_BASE_URL ?? "(未注入)"}`);
      } catch {
        // 日志失败不影响功能
      }

      return () => {
        disposers.forEach((fn) => typeof fn === "function" && fn());
        if (aliasServer) {
          try {
            aliasServer.close();
          } catch {
            // 忽略关闭异常
          }
          alias.status = "closed";
        }
      };
    }, "dsh-openai-gateway: routes");
  });
}
