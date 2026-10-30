// test/smoke.mjs —— 不启动 DSH 的端到端冒烟测试。
// 用模拟的 Cordis 上下文（webServer / settings / credentials / llm）加载插件，校验：
//   路由注册、/v1/info 端口、固定端口别名、鉴权、/v1/models、
//   /v1/chat/completions 转发（含流式）、端口占用降级。
import http from "node:http";
import { apply } from "../index.js";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

// ---------- 1. 模拟上游 LLM ----------
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");

  if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
    res.writeHead(404).end("not found");
    return;
  }

  if (body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const t of ["你", "好", "，", "世", "界"]) {
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: t } }] })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-smoke",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: `ECHO:${body.messages?.[0]?.content ?? ""}` }, finish_reason: "stop" }],
      _auth: req.headers.authorization ?? "",
    }),
  );
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${upstreamPort}/v1`;
process.env.DEEPSEEK_API_KEY = "sk-smoke-upstream";
process.env.JOYIN_WORKER_MODELS_JSON = JSON.stringify([
  { id: "smoke-model-a", name: "Smoke A" },
  { id: "smoke-model-b", name: "Smoke B" },
]);

// ---------- 2. 共享的 credentials / llm ----------
const store = new Map();
const credentials = {
  async resolve(ref) {
    return store.has(ref) ? { value: store.get(ref) } : undefined;
  },
  async set(ref, value) {
    store.set(ref, value);
  },
};

const llm = {
  async listProviders() {
    return [{ id: "deepseek-official", name: "DeepSeek" }];
  },
  async listModels(providerId) {
    if (providerId !== "deepseek-official") return [];
    return [
      { id: "smoke-model-a", name: "Smoke A", contextWindow: 600000, maxTokens: 65536 },
      { id: "smoke-model-b", name: "Smoke B", contextWindow: 600000, maxTokens: 65536 },
    ];
  },
};

/** 模拟一个 DSH 宿主上下文并加载插件。 */
async function mount(fixedPort) {
  const routes = new Map();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const handler = routes.get(path);
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "no route" } }));
      return;
    }
    Promise.resolve(handler(req, res)).catch((e) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: e.message } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const webServer = {
    host: "127.0.0.1",
    port,
    protocol: "http",
    getOrigin: () => `http://127.0.0.1:${port}`,
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  };

  const disposers = [];
  const webCtx = {
    webServer,
    credentials,
    llm,
    settings: {},
    get: () => undefined,
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
    },
  };

  let injected = false;
  apply(
    {
      inject(_deps, cb) {
        injected = true;
        cb(webCtx);
      },
    },
    { fixedPort },
  );

  return {
    port,
    routes,
    injected,
    async dispose() {
      for (const d of disposers) d();
      await new Promise((r) => server.close(r));
    },
  };
}

// ---------- 3. 主实例（启用固定端口别名） ----------
const aliasPort = await freePort();
const main = await mount(aliasPort);
const port = main.port;
const base = `http://127.0.0.1:${port}`;
const aliasBase = `http://127.0.0.1:${aliasPort}`;

check("插件注入 webServer 等依赖", main.injected);
check("注册 4 条路由", main.routes.size === 4, [...main.routes.keys()].join(", "));

// 3.1 /v1/info 本机免鉴权，且返回真实端口
{
  const r = await fetch(`${base}/v1/info`);
  const j = await r.json();
  check("/v1/info 本机可访问", r.status === 200, `status=${r.status}`);
  check("/v1/info 返回真实监听端口", j.listening?.port === port, `port=${j.listening?.port} 期望=${port}`);
  check("/v1/info 返回 baseURL", j.listening?.baseURL === `http://127.0.0.1:${port}/v1`, j.listening?.baseURL);
  check("/v1/info 模型数来自 llm seam", j.models?.total === 2, `total=${j.models?.total}`);
  check("/v1/info 不泄露上游密钥", !JSON.stringify(j).includes("sk-smoke-upstream"));
}

// 3.2 未带密钥 -> 401
{
  const r = await fetch(`${base}/v1/models`);
  check("/v1/models 无密钥返回 401", r.status === 401, `status=${r.status}`);
}

// 3.3 创建密钥
let secret = null;
{
  const r = await fetch(`${base}/v1/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: "smoke" }) });
  const j = await r.json();
  secret = j.key?.secret ?? null;
  check("POST /v1/keys 创建密钥", r.status === 200 && typeof secret === "string" && secret.startsWith("jog_"), secret?.slice(0, 12));
}

// 3.4 带密钥列模型
{
  const r = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
  const j = await r.json();
  check("/v1/models 带密钥返回 200", r.status === 200, `status=${r.status}`);
  check("/v1/models 枚举到 2 个模型", j.data?.length === 2, JSON.stringify(j.data?.map((m) => m.id)));
}

// 3.5 非流式补全
{
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "smoke-model-a", messages: [{ role: "user", content: "ping" }] }),
  });
  const j = await r.json();
  check("非流式补全 200", r.status === 200, `status=${r.status}`);
  check("非流式内容正确转发", j.choices?.[0]?.message?.content === "ECHO:ping", j.choices?.[0]?.message?.content);
  check("上游收到 Bearer 凭据", j._auth === "Bearer sk-smoke-upstream", j._auth);
}

// 3.6 流式补全
{
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "smoke-model-b", messages: [{ role: "user", content: "hi" }], stream: true }),
  });
  const text = await r.text();
  const deltas = text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? "";
      } catch {
        return "";
      }
    })
    .join("");
  check("流式补全返回 SSE", (r.headers.get("content-type") ?? "").includes("text/event-stream"));
  check("流式增量拼接完整", deltas === "你好，世界", deltas);
  check("流式以 [DONE] 结束", text.includes("data: [DONE]"));
}

// 3.7 未知模型
{
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "x" }] }),
  });
  check("未知模型返回 404", r.status === 404, `status=${r.status}`);
}

// ---------- 4. 固定端口别名 ----------
{
  await sleep(200);
  const r = await fetch(`${aliasBase}/v1/info`);
  const j = await r.json();
  check("别名端口 /v1/info 可访问", r.status === 200, `status=${r.status}`);
  check("别名状态为 listening", j.alias?.status === "listening", j.alias?.status);
  check("别名与 DSH 动态端口不同", aliasPort !== port, `${aliasPort} vs ${port}`);
  check("推荐基址指向别名", j.recommendedBaseURL === `http://127.0.0.1:${aliasPort}/v1`, j.recommendedBaseURL);
  check("别名仍报告 DSH 动态端口", j.listening?.port === port, `dsh=${j.listening?.port}`);

  // 别名上跑一整套调用（新建密钥 -> 补全），证明复用同一套 handler
  const k = await (
    await fetch(`${aliasBase}/v1/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "via-alias" }),
    })
  ).json();
  const viaKey = k.key?.secret;
  check("别名上可创建密钥", typeof viaKey === "string", viaKey?.slice(0, 12));

  const chat = await fetch(`${aliasBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${viaKey}` },
    body: JSON.stringify({ model: "smoke-model-a", messages: [{ role: "user", content: "alias" }] }),
  });
  const cj = await chat.json();
  check("别名上非流式补全可用", chat.status === 200 && cj.choices?.[0]?.message?.content === "ECHO:alias", `status=${chat.status}`);
  check("别名上未知路径 404", (await fetch(`${aliasBase}/nope`)).status === 404);
  check("主路由同时可用", (await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } })).status === 200);
}

// ---------- 5. 密钥吊销 ----------
{
  const list = await (await fetch(`${base}/v1/keys`)).json();
  const id = list.keys?.find((x) => x.label === "smoke")?.id;
  const d = await fetch(`${base}/v1/keys?id=${id}`, { method: "DELETE" });
  check("DELETE /v1/keys 吊销成功", d.status === 200, `status=${d.status}`);
  const after = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${secret}` } });
  check("吊销后密钥失效 401", after.status === 401, `status=${after.status}`);
}

// ---------- 6. 固定端口被占用时的降级 ----------
{
  await main.dispose();
  await sleep(150);
  check("主实例释放别名端口", await portIsFree(aliasPort));

  const blocker = http.createServer((req, res) => res.writeHead(200).end("blocker"));
  await new Promise((r) => blocker.listen(aliasPort, "127.0.0.1", r));

  const second = await mount(aliasPort);
  await sleep(300);
  const j = await (await fetch(`http://127.0.0.1:${second.port}/v1/info`)).json();
  check("端口被占用时别名状态为 occupied", j.alias?.status === "occupied", j.alias?.status);
  check("占用时回退到 DSH 动态端口", j.recommendedBaseURL === `http://127.0.0.1:${second.port}/v1`, j.recommendedBaseURL);
  check("占用时 DSH 端口路由仍可用", (await fetch(`http://127.0.0.1:${second.port}/v1/info`)).status === 200);

  await second.dispose();
  await new Promise((r) => blocker.close(r));
}

// ---------- 7. 汇总 ----------
upstream.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : `${failed.length} 项失败`}：${results.length - failed.length}/${results.length}`);
process.exit(failed.length === 0 ? 0 : 1);
