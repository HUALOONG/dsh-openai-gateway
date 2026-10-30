// providers.js —— Provider 配置收集、按模型路由、凭据解析与上游请求构造。
// 设计对齐 @joyin/dsh-model-gateway（已验证的 DSH 宿主用法，2026-10-30）：
//   - 平台 provider（deepseek-official）从进程环境重建（JoyinCode 注入的权威来源）；
//   - 自定义 provider 从 configEditor 读 llm-pi-ai 运行时配置（best-effort）；
//   - 请求直接 fetch 上游 LLM 提供商（DSH 持有配置与凭据，网关做 OpenAI 兼容翻译）。

export const PLATFORM_PROVIDER = "deepseek-official";
export const WORKBUDDY_PROVIDER = "workbuddy-cn";
export const WORKBUDDY_BASE_URL = "https://copilot.tencent.com/v2";

/** 供日志/信息端点使用的 provider id 常量表。 */
export const PROVIDER_IDS = {
  PLATFORM: PLATFORM_PROVIDER,
  WORKBUDDY: WORKBUDDY_PROVIDER,
};

const SETTINGS_NS = "llm-pi-ai";

/** 读取 JoyinCode 注入的模型目录（含 context/output 元数据）。 */
export function envModels() {
  try {
    const v = JSON.parse(process.env.JOYIN_WORKER_MODELS_JSON ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 平台 provider：从进程环境重建（JoyinCode 注入，权威来源）。 */
export function platformProvider() {
  const models = envModels();
  if (!process.env.DEEPSEEK_BASE_URL && models.length === 0) return undefined;
  return {
    api: "openai-completions",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    baseURL: process.env.DEEPSEEK_BASE_URL,
    models,
  };
}

/** WorkBuddy provider：默认注册，模型由调用方按需填充（无 key 时为空数组，不参与路由）。 */
export function workbuddyProvider() {
  return {
    api: "openai-completions",
    apiKeyEnv: "WORKBUDDY_API_KEY",
    baseURL: WORKBUDDY_BASE_URL,
    models: [],
  };
}

/** 读 llm-pi-ai 条目的运行时配置（configEditor），best-effort。 */
function readPiAiConfig(webCtx) {
  const ce = webCtx.get?.("configEditor");
  if (!ce || typeof ce.configuration !== "function") return null;
  const rows = ce.configuration();
  const row = rows.find((r) => r?.entry?.options?.id === SETTINGS_NS);
  return row?.entry?.fiber?.config ?? null;
}

/** 聚合所有 provider 配置：平台 provider（优先）+ WorkBuddy + 自定义 provider（去重）。 */
export function collectProviders(webCtx) {
  const out = {};
  const platform = platformProvider();
  if (platform) out[PLATFORM_PROVIDER] = platform;
  out[WORKBUDDY_PROVIDER] = workbuddyProvider();
  try {
    const cfg = readPiAiConfig(webCtx);
    if (cfg?.providers && typeof cfg.providers === "object") {
      for (const [id, p] of Object.entries(cfg.providers)) {
        if (!(id in out)) out[id] = p;
      }
    }
  } catch {
    // configEditor 不可用或读取失败，不影响平台 provider。
  }
  return out;
}

/** 在 DSH 已配置 provider 中按 model id 查找归属。settings 可为 {providers} 或扁平 map。 */
export function resolveProvider(settings, model) {
  const providers = settings?.providers ?? settings ?? {};
  for (const [providerId, cfg] of Object.entries(providers)) {
    const models = Array.isArray(cfg?.models) ? cfg.models : [];
    const hit = models.some((m) => (typeof m === "string" ? m === model : m?.id === model));
    if (hit) return { providerId, cfg };
  }
  return undefined;
}

/**
 * 解析 provider 的凭据（与 DSH 的 dsh-llm-pi-ai 约定对齐）。
 * 支持：env:XXX、裸环境变量名（先读 process.env 再试 credentials.resolve）、字面量。
 */
export async function resolveApiKey(credentials, cfg) {
  const raw = cfg?.apiKey ?? cfg?.apiKeyEnv;
  if (!raw || typeof raw !== "string") return undefined;
  if (raw.startsWith("env:")) return process.env[raw.slice(4)];
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    if (process.env[raw]) return process.env[raw];
    try {
      const resolved = await credentials?.resolve?.(raw);
      if (resolved?.value) return resolved.value;
    } catch {
      // 未解析则视为缺失凭据
    }
    return undefined;
  }
  return raw;
}

export function providerFamily(providerId, cfg) {
  const id = String(providerId).toLowerCase();
  const api = String(cfg?.api ?? "").toLowerCase();
  if (api.includes("anthropic") || id.includes("anthropic") || cfg?.baseURL?.includes("anthropic")) return "anthropic";
  if (id.includes("workbuddy") || id.includes("codebuddy") || cfg?.baseURL?.includes("copilot.tencent.com")) return "workbuddy";
  return "openai-compatible";
}

/**
 * 构建上游请求。返回 { url, init, family } 或 { unsupported: true, message }。
 * openaiBody 已是 OpenAI chat/completions 格式。
 */
export async function buildUpstreamRequest({ providerId, cfg, credentials, openaiBody, signal }) {
  const family = providerFamily(providerId, cfg);

  if (family === "openai-compatible") {
    const rawBase = (cfg?.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const baseURL = /\/chat\/completions$/.test(rawBase) ? rawBase : `${rawBase}/chat/completions`;
    const apiKey = await resolveApiKey(credentials, cfg);
    const headers = { "content-type": "application/json", accept: "text/event-stream" };
    if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
    return { url: baseURL, init: { method: "POST", headers, body: JSON.stringify(openaiBody), signal }, family };
  }

  if (family === "workbuddy") {
    const apiKey = await resolveApiKey(credentials, cfg);
    const headers = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-client": process.env.DSH_GATEWAY_CLIENT_ID ?? "dsh-openai-gateway",
      "x-client-version": process.env.DSH_GATEWAY_CLIENT_VERSION ?? "0.1.0",
    };
    if (apiKey) {
      headers["authorization"] = `Bearer ${apiKey}`;
      headers["x-api-key"] = apiKey;
    }
    return { url: `${WORKBUDDY_BASE_URL}/chat/completions`, init: { method: "POST", headers, body: JSON.stringify(openaiBody), signal }, family };
  }

  if (family === "anthropic") {
    // 预留：anthropic 通道需双向翻译，当前聚焦 openai-compatible / workbuddy。
    return { unsupported: true, message: `anthropic 通道暂未内置，请使用 openai-compatible 或 workbuddy provider` };
  }

  return { unsupported: true, message: `未知 provider 家族：${providerId}` };
}
