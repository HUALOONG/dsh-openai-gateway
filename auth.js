// auth.js —— 网关对外 API Key 管理。
// 密钥仅以 SHA-256 哈希形式存于 DSH credentials，明文只在创建时返回一次。
//
// 注意：credentials 的 ref 名必须匹配 /^[A-Za-z_][A-Za-z0-9_]*$/。
// 使用冒号或连字符会在 DSH 启动时触发 parseCredentialsDocument 解析异常。
// 本插件使用独立 ref，避免与其它网关插件（如 @joyin/dsh-model-gateway 的
// dsh_gateway_keys）互相覆盖。
import { createHash, randomBytes } from "node:crypto";
import { json, newId } from "./util.js";

const KEYS_REF = "joyin_openai_gateway_keys";
const KEY_PREFIX = "jog_";

function hashKey(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

async function loadStore(credentials) {
  try {
    const stored = await credentials?.resolve?.(KEYS_REF);
    if (!stored?.value) return { version: 1, keys: [] };
    const parsed = JSON.parse(stored.value);
    if (!parsed || !Array.isArray(parsed.keys)) return { version: 1, keys: [] };
    return parsed;
  } catch {
    return { version: 1, keys: [] };
  }
}

async function saveStore(credentials, store) {
  await credentials?.set?.(KEYS_REF, JSON.stringify(store));
}

/** 创建密钥，返回 { ...entry, secret }。secret 仅此一次可见，务必保存。 */
export async function createKey(credentials, label) {
  const raw = KEY_PREFIX + randomBytes(24).toString("base64url");
  const store = await loadStore(credentials);
  const entry = {
    id: newId("key"),
    label: typeof label === "string" && label.trim() ? label.trim() : `Gateway Key ${store.keys.length + 1}`,
    prefix: raw.slice(0, KEY_PREFIX.length + 8),
    hash: hashKey(raw),
    createdAt: new Date().toISOString(),
  };
  store.keys.push(entry);
  await saveStore(credentials, store);
  return { ...entry, secret: raw };
}

/** 校验 Authorization: Bearer <key>。 */
export async function verifyKey(credentials, authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const raw = authorization.slice("Bearer ".length).trim();
  if (!raw) return false;
  const store = await loadStore(credentials);
  const target = hashKey(raw);
  return store.keys.some((k) => k.hash === target);
}

export async function revokeKey(credentials, id) {
  const store = await loadStore(credentials);
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => k.id !== id);
  await saveStore(credentials, store);
  return before !== store.keys.length;
}

export async function listKeys(credentials) {
  const store = await loadStore(credentials);
  return store.keys.map(({ id, label, prefix, createdAt }) => ({ id, label, prefix, createdAt }));
}

export async function countKeys(credentials) {
  const store = await loadStore(credentials);
  return store.keys.length;
}

/** 请求鉴权：失败写 401 并返回 false。 */
export async function requireGatewayAuth(credentials, req, res) {
  const ok = await verifyKey(credentials, req.headers.authorization);
  if (!ok) {
    json(res, 401, {
      error: {
        message: "无效或缺失的网关 API Key",
        hint: "在本机执行 POST /v1/keys 创建密钥，然后使用 Authorization: Bearer <key>",
      },
    });
    return false;
  }
  return true;
}
