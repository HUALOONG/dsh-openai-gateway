// util.js —— 与宿主 DSH WebServer 交互的轻量工具。
// 签名与 @joyin/dsh-model-gateway 的 util.js 对齐（已验证的 DSH 宿主用法）。
import { randomUUID } from "node:crypto";

/** 写 JSON 响应。 */
export function json(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

/** 解析 JSON 请求体，带大小上限保护。 */
export async function requestBody(req, limitBytes = 16 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("请求体超出大小限制");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * 仅允许来自本机 DSH UI / 本地管理端的请求。
 * 用于 /v1/keys、/v1/info 等敏感端点：外部第三方调用应走 Bearer API Key。
 */
export function isLocalRequest(req) {
  const remote = req.socket?.remoteAddress;
  if (remote && LOOPBACK.has(remote)) return true;
  const origin = req.headers.origin;
  return typeof origin === "string" && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1])(:\d+)?$/i.test(origin);
}

export function newId(prefix = "id") {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}
