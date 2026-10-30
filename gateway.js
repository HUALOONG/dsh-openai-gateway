// gateway.js —— OpenAI 兼容端点处理。
//   POST /v1/chat/completions  流式 / 非流式
//   GET  /v1/models            通过 DSH llm seam 枚举模型
//   GET  /v1/info              运行状态与监听端口（本插件核心差异化能力）
import { json, requestBody } from "./util.js";
import { resolveProvider, buildUpstreamRequest, providerFamily, envModels } from "./providers.js";
import { countKeys } from "./auth.js";

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return String(text).slice(0, 2000);
  }
}

/** 补齐 llm seam 未返回的上下文/输出上限（来自 JoyinCode 注入的模型目录）。 */
function metaOf(id) {
  const hit = envModels().find((m) => m?.id === id);
  if (!hit) return {};
  const ctx = hit.context ?? hit.contextWindow ?? hit.maxInputTokens;
  const out = hit.output ?? hit.maxTokens ?? hit.maxOutputTokens;
  return {
    ...(ctx ? { context_window: ctx } : {}),
    ...(out ? { max_output_tokens: out } : {}),
  };
}

/** 通过 DSH llm seam 枚举所有 provider 的物化模型；seam 不可用时退回配置列表。 */
async function collectModels({ settings, llm }) {
  const data = [];
  const seen = new Set();
  const byProvider = {};

  if (llm && typeof llm.listProviders === "function") {
    try {
      const providers = await llm.listProviders();
      for (const p of providers) {
        let models = [];
        try {
          models = await llm.listModels(p.id);
        } catch {
          models = [];
        }
        for (const m of models) {
          if (!m?.id || seen.has(m.id)) continue;
          seen.add(m.id);
          byProvider[p.id] = (byProvider[p.id] ?? 0) + 1;
          data.push({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: p.id,
            name: m.name ?? m.id,
            ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
            ...(m.maxTokens ? { max_output_tokens: m.maxTokens } : {}),
            ...metaOf(m.id),
          });
        }
      }
      if (data.length > 0) return { data, byProvider };
    } catch {
      // seam 枚举失败，走配置兜底
    }
  }

  const providers = settings?.providers ?? settings ?? {};
  for (const [providerId, cfg] of Object.entries(providers)) {
    const models = Array.isArray(cfg?.models) ? cfg.models : [];
    for (const m of models) {
      const id = typeof m === "string" ? m : m?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      byProvider[providerId] = (byProvider[providerId] ?? 0) + 1;
      data.push({
        id,
        object: "model",
        created: 0,
        owned_by: providerId,
        name: (typeof m === "object" && m?.name) || id,
        ...(typeof m === "object" ? metaOf(id) : {}),
      });
    }
  }
  return { data, byProvider };
}

/** GET /v1/models */
export async function handleListModels(req, res, ctx) {
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });
  const { data } = await collectModels(ctx);
  json(res, 200, { object: "list", data });
}

/** POST /v1/chat/completions */
export async function handleChatCompletions(req, res, { settings, credentials }) {
  if (req.method !== "POST") return json(res, 405, { error: { message: "Method not allowed" } });

  let body;
  try {
    body = await requestBody(req);
  } catch {
    return json(res, 400, { error: { message: "请求体解析失败或非 JSON" } });
  }

  const model = body?.model;
  if (!model) return json(res, 400, { error: { message: "缺少 model 字段" } });
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return json(res, 400, { error: { message: "缺少 messages 字段" } });
  }

  const provider = resolveProvider(settings, model);
  if (!provider) {
    return json(res, 404, {
      error: {
        message: `未在 DSH 中找到模型 ${model} 的归属 provider`,
        hint: "GET /v1/models 查看可用模型",
      },
    });
  }

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  const upstream = await buildUpstreamRequest({
    providerId: provider.providerId,
    cfg: provider.cfg,
    credentials,
    openaiBody: body,
    signal: controller.signal,
  });
  if (upstream.unsupported) {
    return json(res, 501, { error: { message: upstream.message } });
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstream.url, upstream.init);
  } catch (err) {
    if (controller.signal.aborted) return;
    return json(res, 502, {
      error: {
        message: `上游请求失败：${err?.message ?? err}`,
        provider: provider.providerId,
        family: upstream.family,
      },
    });
  }

  if (!upstreamRes.ok) {
    const text = await upstreamRes.text().catch(() => "");
    return json(res, upstreamRes.status, {
      error: {
        message: `上游错误（HTTP ${upstreamRes.status}）`,
        provider: provider.providerId,
        detail: safeJson(text),
      },
    });
  }

  const stream = Boolean(body.stream);
  res.writeHead(200, {
    "content-type": stream ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-gateway-provider": provider.providerId,
  });

  if (!stream) {
    const text = await upstreamRes.text();
    res.end(text);
    return;
  }

  try {
    for await (const chunk of upstreamRes.body) {
      res.write(chunk);
    }
  } catch {
    // 客户端断开或上游中断，controller 已 abort
  }
  res.end();
}

/**
 * GET /v1/info —— 运行状态与监听端口。
 * 这是"显示监听端口"的核心：直接读取 DSH WebServer 的 host/port/protocol。
 * 本机访问无需密钥；非本机访问需 Bearer 密钥。
 */
export async function handleInfo(req, res, ctx) {
  if (req.method !== "GET") return json(res, 405, { error: { message: "Method not allowed" } });

  const { webServer, credentials, settings, llm, meta } = ctx;

  const host = webServer?.host ?? "127.0.0.1";
  const port = webServer?.port ?? null;
  // webServer.protocol 形如 "http:"（URL.protocol 风格），展示时去掉尾冒号。
  const protocol = String(webServer?.protocol ?? "http").replace(/:$/, "");
  let origin = null;
  try {
    origin = typeof webServer?.getOrigin === "function" ? webServer.getOrigin() : null;
  } catch {
    origin = null;
  }
  if (!origin && port) origin = `${protocol}://${host}:${port}`;

  const { data, byProvider } = await collectModels({ settings, llm });
  let keyCount = 0;
  try {
    keyCount = await countKeys(credentials);
  } catch {
    keyCount = 0;
  }

  // 固定端口别名（由 index.js 维护）。就绪时优先推荐它 —— 不随 DSH 重启漂移。
  const aliasInfo = meta?.alias ?? { enabled: false, status: "disabled", port: null, baseURL: null };
  const dshBaseURL = origin ? `${origin}/v1` : null;
  const recommendedBaseURL = aliasInfo.status === "listening" ? aliasInfo.baseURL : dshBaseURL;

  json(res, 200, {
    ok: true,
    plugin: {
      name: meta?.name ?? "@joyin/dsh-openai-gateway",
      version: meta?.version ?? "0.0.0",
      kind: "dsh-desktop-plugin",
    },
    listening: {
      protocol,
      host,
      port,
      displayPort: port,
      origin,
      baseURL: dshBaseURL,
      note: port
        ? "端口由 DSH 启动时动态分配（JoyinCode 固定传 --port 0），重启后会变化。外部工具请优先使用 alias。"
        : "尚未取得端口信息（WebServer 未就绪）。",
    },
    alias: {
      ...aliasInfo,
      note:
        aliasInfo.status === "listening"
          ? "固定端口别名已就绪，可长期写死；DSH 重启不影响。"
          : aliasInfo.status === "occupied"
            ? "固定端口被其它进程占用，别名未生效；请改 config.fixedPort 或释放该端口。"
            : "固定端口别名未启用。",
    },
    recommendedBaseURL,
    endpoints: [
      { method: "POST", path: "/v1/chat/completions", auth: "bearer", description: "OpenAI 兼容对话补全（支持 stream）" },
      { method: "GET", path: "/v1/models", auth: "bearer", description: "列出 DSH 当前可用模型" },
      { method: "GET", path: "/v1/info", auth: "local-or-bearer", description: "运行状态与监听端口" },
      { method: "POST", path: "/v1/keys", auth: "local-only", description: "创建网关 API Key" },
      { method: "GET", path: "/v1/keys", auth: "local-only", description: "列出网关 API Key（不含明文）" },
      { method: "DELETE", path: "/v1/keys?id=...", auth: "local-only", description: "吊销网关 API Key" },
    ],
    models: {
      total: data.length,
      providers: byProvider,
      platformProvider: "deepseek-official",
      upstreamBaseURL: process.env.DEEPSEEK_BASE_URL ? redactUrl(process.env.DEEPSEEK_BASE_URL) : null,
    },
    keys: { count: keyCount },
    runtime: {
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      startedAt: meta?.startedAt ?? null,
      uptimeSeconds: meta?.startedAt ? Math.round((Date.now() - Date.parse(meta.startedAt)) / 1000) : null,
    },
  });
}

/** 脱敏展示上游地址：保留 host:port，隐藏可能的凭据片段。 */
function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return String(raw).split("?")[0];
  }
}

export { providerFamily };
