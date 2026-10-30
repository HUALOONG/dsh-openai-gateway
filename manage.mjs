#!/usr/bin/env node
// manage.mjs —— DSH 桌面插件生命周期管理（安装 / 卸载 / 状态 / 端口与运行信息）。
//
// 用法：
//   node manage.mjs install     安装本插件到当前账号的 web profile
//   node manage.mjs uninstall   卸载本插件
//   node manage.mjs update      更新（本地路径插件等同重装）
//   node manage.mjs status      查看安装状态（依赖 + 是否已激活为 bundle）
//   node manage.mjs info        发现并展示实际监听端口与运行信息
//   node manage.mjs sync        把当前端口/密钥/模型同步进 WorkBuddy 的 models.json（可选）
//
// 可选参数：
//   --dsh-home <dir>      指定 DSH 账号目录（默认自动探测 profiles/web 所在账号）
//   --runtime-root <dir>  JoyinCode 运行时根目录（默认自动探测）
//   --port <n>            info 时跳过端口扫描，直连指定端口
//   --json                以 JSON 输出（便于脚本消费）

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const PKG = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const SELF_DIR = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const IS_WIN = platform() === "win32";

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const command = argv[0] ?? "status";
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(`--${name}`);
const asJson = has("json");

/** 固定端口默认值，与 cordis.patch.yml 的 config.fixedPort 保持一致。 */
const DEFAULT_FIXED_PORT = Number(flag("fixed-port") ?? process.env.DSH_GATEWAY_FIXED_PORT ?? 9527);

// ---------- 路径探测 ----------
function appDataRoot() {
  return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
}

/** 探测 DSH 账号目录：优先命令行，其次枚举 accounts 下含 profiles/web 的目录。 */
function detectDshHome() {
  const explicit = flag("dsh-home");
  if (explicit) {
    if (!existsSync(join(explicit, "profiles", "web"))) {
      fail(`指定目录不是有效的 DSH 账号目录（缺 profiles/web）：${explicit}`);
    }
    return resolve(explicit);
  }
  const accountsDir = join(appDataRoot(), "@joyin", "joyin-worker", "dsh", "accounts");
  if (!existsSync(accountsDir)) fail(`未找到 DSH 账号目录：${accountsDir}`);
  const candidates = readdirSync(accountsDir)
    .map((d) => join(accountsDir, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory() && existsSync(join(d, "profiles", "web", "package.json"));
      } catch {
        return false;
      }
    });
  if (candidates.length === 0) fail(`未找到含 profiles/web 的账号目录：${accountsDir}`);
  if (candidates.length === 1) return candidates[0];
  // 多个账号时，选 profiles/web 最近修改的
  candidates.sort((a, b) => mtime(join(b, "profiles", "web", "package.json")) - mtime(join(a, "profiles", "web", "package.json")));
  return candidates[0];
}

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** 探测 JoyinCode 运行时根目录（含 node_modules/@deepseek-ai/dsh）。 */
function detectRuntimeRoot() {
  const explicit = flag("runtime-root");
  const ok = (root) => root && existsSync(join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"));

  if (explicit) {
    if (!ok(explicit)) fail(`指定运行时目录缺少 @deepseek-ai/dsh：${explicit}`);
    return resolve(explicit);
  }
  if (ok(process.env.JOYIN_WORKER_RUNTIME_ROOT)) return process.env.JOYIN_WORKER_RUNTIME_ROOT;

  // 从正在运行的 dsh 进程反推（Windows）
  if (IS_WIN) {
    try {
      const out = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh[\\\\/]lib[\\\\/]bin\\.js' } | Select-Object -First 1 -ExpandProperty CommandLine",
        ],
        { encoding: "utf8", timeout: 15000, windowsHide: true },
      ).trim();
      const m = out.match(/[A-Za-z]:\\[^"]*?node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/);
      if (m) {
        const root = resolve(m[0], "..", "..", "..", "..", "..");
        if (ok(root)) return root;
      }
    } catch {
      // 忽略，继续走候选路径
    }
  }

  const candidates = [];
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    for (const base of [local, "C:\\Program Files", "D:\\Program Files", "D:\\99_Downloads\\Programs"]) {
      candidates.push(join(base, "JoyinCode", "resources", "dist", "runtime"));
      candidates.push(join(base, "joyincode", "resources", "dist", "runtime"));
    }
    // 从桌面快捷方式/开始菜单不易解析，这里再兜底扫常见盘符一级目录
    for (const drive of ["C:", "D:", "E:"]) {
      candidates.push(join(`${drive}\\`, "JoyinCode", "resources", "dist", "runtime"));
    }
  } else {
    candidates.push("/Applications/JoyinCode.app/Contents/Resources/app.asar.unpacked/resources/dist/runtime");
    candidates.push(join(homedir(), "Applications", "JoyinCode", "resources", "dist", "runtime"));
  }

  const hit = candidates.find((c) => ok(c));
  if (hit) return hit;
  fail(
    "未能自动定位 JoyinCode 运行时目录。请用 --runtime-root 指定，例如：\n" +
      '  node manage.mjs install --runtime-root "D:\\...\\JoyinCode\\resources\\dist\\runtime"',
  );
}

function paths() {
  const runtimeRoot = detectRuntimeRoot();
  return {
    runtimeRoot,
    runtimeBin: join(runtimeRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    pnpmEntry: join(runtimeRoot, "node_modules", "pnpm", "bin", "pnpm.cjs"),
  };
}

// ---------- 调用 dsh CLI ----------
function runDshPlugin(runtimeBin, dshHome, args, pnpmEntry) {
  return new Promise((res, rej) => {
    const moduleUrl = pathToFileURL(runtimeBin).href;
    const cliArgs = [
      "--expose-internals",
      "-e",
      `import(${JSON.stringify(moduleUrl)}).then(({ runCli }) => runCli()).catch((e) => { console.error(e); process.exitCode = 1 })`,
      "--",
      runtimeBin,
      "plugin",
      "--profile",
      "web",
      ...args,
    ];
    const env = { ...process.env, DSH_HOME: dshHome };
    if (existsSync(pnpmEntry)) {
      env.DSH_PNPM_ENTRY = pnpmEntry;
      env.ELECTRON_RUN_AS_NODE = "1";
    }
    const child = spawn(process.execPath, cliArgs, {
      cwd: dshHome,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", rej);
    child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
  });
}

// ---------- profile 读取 ----------
function readProfile(dshHome) {
  const file = join(dshHome, "profiles", "web", "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function installState(dshHome) {
  const manifest = readProfile(dshHome);
  if (!manifest) return { installed: false, activated: false, version: null };
  const deps = manifest.dependencies ?? {};
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  const installed = Object.prototype.hasOwnProperty.call(deps, PKG.name);
  const activated = bundles.includes(PKG.name);
  let version = null;
  const pj = join(dshHome, "profiles", "web", "node_modules", PKG.name, "package.json");
  if (existsSync(pj)) {
    try {
      version = JSON.parse(readFileSync(pj, "utf8")).version ?? null;
    } catch {
      version = null;
    }
  }
  return { installed, activated, version, spec: deps[PKG.name] ?? null };
}

// ---------- 端口发现 ----------
function listLoopbackPorts() {
  const ports = new Set();
  try {
    if (IS_WIN) {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", timeout: 15000, windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (!m) continue;
        const addr = m[1];
        const port = Number(m[2]);
        if (!(addr === "127.0.0.1" || addr === "[::1]" || addr === "0.0.0.0" || addr === "[::]")) continue;
        if (port < 1024 || port === 8799) continue; // 排除系统端口与旧桥接
        ports.add(port);
      }
    } else {
      const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 15000 });
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = line.match(/:(\d+)\s+\(LISTEN\)/);
        if (m) {
          const port = Number(m[1]);
          if (port >= 1024) ports.add(port);
        }
      }
    }
  } catch {
    // 拿不到就返回空，info 会提示用 --port
  }
  return [...ports].sort((a, b) => b - a);
}

async function probeInfo(port, timeoutMs = 1200) {
  try {
    const ctrl = AbortSignal.timeout(timeoutMs);
    const httpPort = port;
    const res = await fetch(`http://127.0.0.1:${httpPort}/v1/info`, { signal: ctrl });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.plugin?.name !== PKG.name) return null;
    return body;
  } catch {
    return null;
  }
}

async function discoverInfo() {
  const explicit = flag("port");
  if (explicit) {
    const info = await probeInfo(Number(explicit), 3000);
    if (!info) fail(`端口 ${explicit} 上未发现 ${PKG.name} 的 /v1/info（插件未加载或端口不对）`);
    return info;
  }
  // 先试固定端口别名（若已启用，这是最稳的入口）
  if (DEFAULT_FIXED_PORT > 0) {
    const viaAlias = await probeInfo(DEFAULT_FIXED_PORT, 1500);
    if (viaAlias) return viaAlias;
  }
  const ports = listLoopbackPorts();
  for (const port of ports) {
    const info = await probeInfo(port);
    if (info) return info;
  }
  return null;
}

// ---------- 输出 ----------
function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function printInfo(info) {
  const l = info.listening ?? {};
  const a = info.alias ?? {};
  console.log("");
  console.log("  插件        ", `${info.plugin.name} v${info.plugin.version}`);
  console.log("  DSH 动态端口", l.port ?? "(未知)", "（每次重启都变）");
  console.log("  固定端口    ", a.status === "listening" ? `${a.port}  ← 推荐长期使用` : `${a.port ?? "-"}（${a.status ?? "未启用"}）`);
  console.log("  OpenAI 基址 ", info.recommendedBaseURL ?? "(未知)");
  if (a.status === "occupied") console.log("                ", "⚠ 固定端口被占用，请在 cordis.patch.yml 改 config.fixedPort");
  console.log("  可用模型    ", `${info.models?.total ?? 0} 个`);
  for (const [p, n] of Object.entries(info.models?.providers ?? {})) {
    console.log("                ", `- ${p}: ${n}`);
  }
  console.log("  网关密钥    ", `${info.keys?.count ?? 0} 个`);
  console.log("  进程        ", `pid=${info.runtime.pid} node=${info.runtime.node} 已运行 ${info.runtime.uptimeSeconds ?? "?"}s`);
  console.log("");
  console.log("  端点：");
  for (const e of info.endpoints ?? []) {
    console.log("   ", `${e.method.padEnd(6)} ${e.path.padEnd(28)} [${e.auth}]`);
  }
  console.log("");
  console.log(`  第三方调用示例：`);
  console.log(`    baseURL = "${info.recommendedBaseURL}"`);
  console.log(`    apiKey  = "<用 POST http://127.0.0.1:${a.status === "listening" ? a.port : l.port}/v1/keys 创建>"`);
  console.log("");
  console.log(`  提示：固定端口已生效时无需反复 sync；否则请执行 node manage.mjs sync 跟随动态端口。`);
  console.log("");
}

// ---------- WorkBuddy 同步（可选，解决端口漂移） ----------
const WB_MODELS = join(homedir(), ".workbuddy", "models.json");
const SOURCE_TAG = "dsh-openai-gateway";

function readWbModels() {
  if (!existsSync(WB_MODELS)) return [];
  try {
    const v = JSON.parse(readFileSync(WB_MODELS, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    fail(`无法解析 ${WB_MODELS}`);
  }
}

async function validKey(port, key) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** 复用 models.json 里已有的网关密钥；失效则新建一个。 */
async function ensureGatewayKey(port) {
  const existing = [...new Set(readWbModels().filter((e) => e._source === SOURCE_TAG).map((e) => e.apiKey).filter(Boolean))];
  for (const key of existing) {
    if (await validKey(port, key)) return { key, reused: true };
  }
  const r = await fetch(`http://127.0.0.1:${port}/v1/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: "workbuddy" }),
    signal: AbortSignal.timeout(5000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.key?.secret) fail(`创建网关密钥失败：HTTP ${r.status} ${JSON.stringify(j)}`);
  return { key: j.key.secret, reused: false };
}

async function syncWorkBuddy(info) {
  const dshPort = info.listening?.port;
  if (!dshPort) fail("未取得监听端口，无法同步");
  const aliasReady = info.alias?.status === "listening";
  const baseURL = info.recommendedBaseURL || `http://127.0.0.1:${dshPort}/v1`;
  const keyPort = aliasReady ? info.alias.port : dshPort;

  const { key, reused } = await ensureGatewayKey(keyPort);
  const res = await fetch(`${baseURL}/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) fail(`拉取模型列表失败：HTTP ${res.status}`);
  const { data } = await res.json();

  const existing = readWbModels();
  const keep = existing.filter((e) => e._source !== SOURCE_TAG && e.vendor !== "JoyinCode");
  const created = data.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    vendor: "JoyinCode",
    url: baseURL,
    apiKey: key,
    supportsToolCall: true,
    supportsImages: false,
    supportsReasoning: true,
    useCustomProtocol: false,
    ...(m.context_window ? { maxInputTokens: m.context_window } : {}),
    ...(m.max_output_tokens ? { maxOutputTokens: m.max_output_tokens } : {}),
    _source: SOURCE_TAG,
  }));
  const next = [...keep, ...created];

  if (has("dry-run")) {
    console.log(JSON.stringify({ wouldWrite: WB_MODELS, baseURL, keyReused: reused, count: created.length, models: created.map((m) => m.id) }, null, 2));
    return;
  }
  if (existsSync(WB_MODELS)) copyFileSync(WB_MODELS, `${WB_MODELS}.bak-${Date.now()}`);
  writeFileSync(WB_MODELS, `${JSON.stringify(next, null, 2)}\n`, "utf8");

  console.log(`✓ 已同步 ${created.length} 个模型 -> ${WB_MODELS}`);
  console.log(`  baseURL : ${baseURL}`);
  console.log(`  apiKey  : ${key.slice(0, 10)}…（${reused ? "复用已有密钥" : "新建密钥"}）`);
  console.log(`  保留非 JoyinCode 模型 ${keep.length} 个`);
  if (aliasReady) {
    console.log(`  ✓ 使用固定端口别名 ${info.alias.port}，JoyinCode 重启后无需重新 sync。`);
  } else {
    console.log("  注意：当前使用 DSH 动态端口，JoyinCode 重启后需重新执行 node manage.mjs sync。");
    console.log("        建议启用固定端口别名（cordis.patch.yml 的 config.fixedPort，默认 9527）。");
  }
}

// ---------- 主流程 ----------
async function main() {
  const dshHome = detectDshHome();

  if (command === "status") {
    const p = paths();
    const st = installState(dshHome);
    if (asJson) {
      console.log(JSON.stringify({ dshHome, runtimeRoot: p.runtimeRoot, package: PKG.name, ...st }, null, 2));
      return;
    }
    console.log("");
    console.log("  DSH 账号目录 ", dshHome);
    console.log("  运行时目录   ", p.runtimeRoot);
    console.log("  插件包名     ", PKG.name);
    console.log("  已安装       ", st.installed ? `是（${st.version ?? st.spec}）` : "否");
    console.log("  已激活 bundle", st.activated ? "是" : "否（安装后需重启 DSH 才会加载）");
    const info = await discoverInfo();
    console.log("  运行中       ", info ? `是，DSH 端口 ${info.listening.port}` : "未检测到（DSH 未运行或插件未加载）");
    if (info) {
      const a = info.alias ?? {};
      console.log("  固定端口     ", a.status === "listening" ? `${a.port}（已就绪）` : `${a.port ?? "-"}（${a.status ?? "未启用"}）`);
      console.log("  推荐基址     ", info.recommendedBaseURL ?? "-");
    }
    console.log("");
    return;
  }

  if (command === "info") {
    const info = await discoverInfo();
    if (!info) fail("未发现运行中的插件实例。请确认 JoyinCode 已启动且插件已安装激活（node manage.mjs status）");
    if (asJson) return console.log(JSON.stringify(info, null, 2));
    printInfo(info);
    return;
  }

  if (command === "sync") {
    const info = await discoverInfo();
    if (!info) fail("未发现运行中的插件实例。请确认 JoyinCode 已启动且插件已安装激活（node manage.mjs status）");
    await syncWorkBuddy(info);
    return;
  }

  if (command === "install" || command === "update") {
    const p = paths();
    const spec = SELF_DIR;
    console.log(`→ 安装 ${PKG.name} 到 ${dshHome}`);
    console.log(`  运行时：${p.runtimeBin}`);
    const result = await runDshPlugin(p.runtimeBin, dshHome, command === "update" ? ["update", PKG.name] : ["add", spec], p.pnpmEntry);
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.code !== 0) {
      console.error(result.stderr.trim());
      const lock = /lock|EBUSY|ELOCKED|正在运行|in use/i.test(result.stderr);
      fail(lock ? "安装失败：profile 被占用，请完全退出 JoyinCode 桌面应用后重试。" : "安装失败（见上方错误输出）");
    }
    const st = installState(dshHome);
    console.log("");
    console.log(`✓ 已安装（${st.version ?? "?"}），bundle 激活：${st.activated ? "是" : "否"}`);
    if (!st.activated) {
      console.log("  注意：未出现在 dsh.profile.bundles 中，请重启 JoyinCode 后执行 node manage.mjs status 复查。");
    }
    console.log("  重启 JoyinCode 桌面应用后生效；随后执行 node manage.mjs info 查看监听端口。");
    return;
  }

  if (command === "uninstall" || command === "remove") {
    const p = paths();
    console.log(`→ 从 ${dshHome} 卸载 ${PKG.name}`);
    const result = await runDshPlugin(p.runtimeBin, dshHome, ["remove", PKG.name], p.pnpmEntry);
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.code !== 0) {
      console.error(result.stderr.trim());
      const lock = /lock|EBUSY|ELOCKED|正在运行|in use/i.test(result.stderr);
      fail(lock ? "卸载失败：profile 被占用，请完全退出 JoyinCode 桌面应用后重试。" : "卸载失败（见上方错误输出）");
    }
    const st = installState(dshHome);
    console.log("");
    console.log(`✓ 已卸载（依赖残留：${st.installed ? "有" : "无"}，bundle 激活：${st.activated ? "是" : "否"}）`);
    console.log("  重启 JoyinCode 桌面应用后 /v1/* 端点不再提供。");
    return;
  }

  fail(`未知命令：${command}。可用：install | uninstall | update | status | info | sync`);
}

main().catch((err) => fail(err?.stack ?? String(err)));
