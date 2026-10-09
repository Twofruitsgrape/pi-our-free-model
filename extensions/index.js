/**
 * pi-our-free-model - free frontier models for the pi coding agent.
 *
 * Ported from Ebony-Vinyl/dsh-our-free-model (MIT).
 * Original project: https://github.com/Ebony-Vinyl/dsh-our-free-model
 *
 * This extension manages the standalone local service (OpenAI-compatible gateway)
 * and registers it as a pi provider. DeepSeek Harness (DSH) is NOT required.
 */

import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "vendor", "packages", "standalone", "cli.mjs");

const PROVIDER_ID = "our-free-model";
const UPSTREAM_REPO = "Ebony-Vinyl/dsh-our-free-model";
const CURRENT_UPSTREAM_COMMIT = "befe36559e9f642ddac279e8b275558367f9f085";

/** Static fallback catalog, used when live discovery is unavailable. */
const FALLBACK_MODELS = [
  { id: "stealth/glyph-cluster", name: "Glyph Cluster (free)", contextWindow: 256000 },
  { id: "openrouter/free", name: "OpenRouter Free", contextWindow: 200000 },
  { id: "inclusionai/ling-3.1-flash", name: "Ling 3.1 Flash (free)", contextWindow: 262144 },
  { id: "mimo-v2.6-flash-free", name: "MiMo v2.6 Flash (free)", contextWindow: 128000 },
  { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (free)", contextWindow: 128000 },
  { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview (free)", contextWindow: 128000 },
  { id: "cohere/north-mini-code:free", name: "North Mini Code (free)", contextWindow: 256000 },
];

/** Data dir for the gateway (independent of any DSH directory). */
export function resolveDataDir() {
  const fromEnv = process.env.PI_OUR_FREE_MODEL_HOME;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".our-free-model");
}

export function normalizeModelId(id) {
  const raw = String(id ?? "").trim();
  if (!raw) return raw;
  const parts = raw.split("/");
  if (parts.length > 1 && (parts[0] === PROVIDER_ID || parts[0] === "our-free-model-standalone")) {
    return parts.slice(1).join("/");
  }
  return raw;
}

function readSettings(dataDir) {
  try {
    const settingsPath = path.join(dataDir, "settings.json");
    if (!fs.existsSync(settingsPath)) return undefined;
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function clearStaleLock(dataDir, logger) {
  const lockFile = path.join(dataDir, "service.lock");
  if (!fs.existsSync(lockFile)) return false;
  let ownerAlive = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const pid = parsed?.pid;
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid, 0);
        ownerAlive = pid !== process.pid;
      } catch {
        ownerAlive = false;
      }
    }
  } catch {
    ownerAlive = false;
  }
  if (ownerAlive) return false;
  try {
    fs.unlinkSync(lockFile);
    logger?.warn?.("pi-our-free-model: removed a stale service lock left by a previous run.");
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url + "/health", { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === "our-free-model-standalone" || body?.service === "our-free-model";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address()?.port;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) return false;
    if (await probeHealth(url)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let servicePromise = null;
export async function ensureService(logger) {
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const dataDir = resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const settings = readSettings(dataDir);
    const key = settings?.forwardKey;
    const savedPort = settings?.standalonePort;

    if (typeof key === "string" && key !== "" && Number.isInteger(savedPort) && savedPort > 0) {
      const existingUrl = "http://127.0.0.1:" + savedPort;
      if (await probeHealth(existingUrl)) {
        return { url: existingUrl, key, dataDir, spawned: false, port: savedPort };
      }
    }

    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(
        "pi-our-free-model: bundled service not found at " + CLI_ENTRY + ". Reinstall the package."
      );
    }

    const port = await findFreePort();
    const url = "http://127.0.0.1:" + port;

    const spawnOnce = () =>
      spawn(process.execPath, [CLI_ENTRY, "--port", String(port), "--data-dir", dataDir], {
        cwd: PACKAGE_ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...process.env, OFM_STANDALONE: "1" },
      });

    let child = spawnOnce();
    child.unref();

    let healthy = await waitForHealth(url, child, 45000);

    if (!healthy) {
      if (clearStaleLock(dataDir, logger)) {
        try { child.kill(); } catch {}
        child = spawnOnce();
        child.unref();
        healthy = await waitForHealth(url, child, 45000);
      }
    }

    if (!healthy) {
      throw new Error(
        "pi-our-free-model: the local gateway did not become healthy on " + url
      );
    }

    const finalKey = readSettings(dataDir)?.forwardKey ?? key;
    if (!finalKey) throw new Error("pi-our-free-model: could not determine the gateway API key");

    return { url, key: finalKey, dataDir, spawned: true, port };
  })().catch((error) => {
    servicePromise = null;
    throw error;
  });
  return servicePromise;
}

async function discoverModels(service, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(service.url + "/v1/models", {
      headers: { Authorization: "Bearer " + service.key },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    if (!Array.isArray(body?.data)) return undefined;
    const entries = body.data
      .filter((e) => typeof e?.id === "string" && e.id !== "")
      .map((e) => ({
        id: e.id,
        contextWindow: Number.isFinite(e.context_window) ? e.context_window : undefined,
      }));
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function readCatalogMeta(dataDir) {
  const meta = new Map();
  try {
    const catalogPath = path.join(dataDir, "catalog.json");
    if (!fs.existsSync(catalogPath)) return meta;
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
    const rows = Array.isArray(catalog?.kiloRows) ? catalog.kiloRows : [];
    for (const row of rows) {
      if (typeof row?.id !== "string") continue;
      meta.set(row.id, {
        name: typeof row.name === "string" ? row.name : undefined,
        contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : undefined,
        maxOutput: Number.isFinite(row.maxOutput) ? row.maxOutput : undefined,
        reasoning: row.reasoning !== false,
        vision: row.vision === true,
      });
    }
  } catch {}
  return meta;
}

const NON_CHAT_MODEL_IDS = new Set(["jev-1.13-free", "exo-free"]);

function humanizeModelId(id) {
  const tail = String(id).split("/").pop() ?? String(id);
  const spaced = tail.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return spaced.replace(/\s*Free\b/, " (free)").trim();
}

function toPiModel(entry, meta) {
  const id = normalizeModelId(entry.id);
  const info = meta.get(entry.id) ?? meta.get(id);
  const contextWindow = info?.contextWindow ?? entry.contextWindow ?? 128000;
  const maxTokens = Math.min(info?.maxOutput ?? 32000, contextWindow);
  return {
    id,
    name: info?.name ?? humanizeModelId(id),
    reasoning: info?.reasoning !== false,
    input: info?.vision ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxTokens > 0 ? maxTokens : 32000,
    compat: {
      supportsDeveloperRole: false,
      supportsFinishReason: false,
      maxTokensField: "max_tokens",
    },
  };
}

async function discoverModelsWhenReady(service, logger, { attempts = 12, delayMs = 1500 } = {}) {
  let best;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await discoverModels(service, 20000);
    if (found && found.length > 0) {
      best = found;
      if (found.length >= FALLBACK_MODELS.length || attempt >= 2) return found;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return best;
}

export async function buildProviderConfig(service, logger) {
  const discovered = await discoverModelsWhenReady(service, logger);
  const meta = readCatalogMeta(service.dataDir);

  const byId = new Map();
  for (const m of FALLBACK_MODELS) {
    byId.set(m.id, toPiModel({ id: m.id, contextWindow: m.contextWindow }, meta));
  }
  if (discovered) {
    for (const entry of discovered) {
      if (NON_CHAT_MODEL_IDS.has(entry.id)) continue;
      const model = toPiModel(entry, meta);
      byId.set(model.id, model);
    }
  }
  return {
    baseUrl: service.url + "/v1",
    apiKey: service.key,
    api: "openai-completions",
    models: [...byId.values()],
  };
}

/** Open URL in user's default browser (cross-platform). */
function openBrowser(url) {
  const start = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${start} "${url}"`);
}

/** Copy text to clipboard on Windows / macOS / Linux. */
function copyToClipboard(text) {
  if (process.platform === "win32") {
    const proc = spawn("powershell", ["-NoProfile", "-Command", "$input | Set-Clipboard"], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    proc.stdin.write(text);
    proc.stdin.end();
  }
}

/** Check upstream repository for new commits or releases. */
async function checkUpstreamUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/main`, {
      headers: { "User-Agent": "pi-our-free-model" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { error: `GitHub API 返回错误: ${res.status}` };
    const data = await res.json();
    const latestSha = data.sha;
    const isNewer = latestSha !== CURRENT_UPSTREAM_COMMIT;
    return {
      isNewer,
      latestSha: latestSha.slice(0, 8),
      currentSha: CURRENT_UPSTREAM_COMMIT.slice(0, 8),
      commitDate: data.commit?.author?.date,
      message: (data.commit?.message || "").split("\n")[0],
    };
  } catch (e) {
    return { error: `检查更新超时或失败: ${e.message}` };
  }
}

export default function registerOurFreeModel(pi) {
  const logger = {
    debug: (msg) => pi.logger?.debug?.(msg),
    info: (msg) => pi.logger?.info?.(msg),
    warn: (msg) => pi.logger?.warn?.(msg),
  };

  let ready = null;
  const boot = () => {
    if (!ready) {
      ready = (async () => {
        const service = await ensureService(logger);
        const config = await buildProviderConfig(service, logger);
        pi.registerProvider(PROVIDER_ID, config);
        logger.info?.(
          `pi-our-free-model: ${config.models.length} free model(s) available via ${config.baseUrl}`,
        );
        return { service, config };
      })();
    }
    return ready;
  };

  pi.registerCommand("free-models", {
    description: "管理 Our Free Model (free-models [open|update|status])",
    handler: async (args, ctx) => {
      const sub = (args || "").trim().toLowerCase();
      try {
        const state = await boot();
        const { service, config } = state;

        if (sub === "open" || sub === "ui" || sub === "login") {
          // 打开原作者管理后台
          openBrowser(service.url);
          copyToClipboard(service.key);
          ctx.ui?.notify?.(
            `已在浏览器打开管理面板: ${service.url}。\nAPI Key 已复制到剪贴板，如提示登录直接 Ctrl+V 粘贴即可！`
          );
          return;
        }

        if (sub === "update" || sub === "check") {
          ctx.ui?.notify?.("正在检测原作者 GitHub 最新版本...");
          const update = await checkUpstreamUpdate();
          if (update.error) {
            ctx.ui?.notify?.(update.error);
          } else if (update.isNewer) {
            ctx.ui?.notify?.(
              `发现原作者有新更新！\n最新提交: [${update.latestSha}] ${update.message}\n提交时间: ${update.commitDate}\n更新包: pi update npm:pi-our-free-model`
            );
          } else {
            ctx.ui?.notify?.(`已是最新！当前基准提交为: [${update.currentSha}]`);
          }
          return;
        }

        // 默认显示状态
        ctx.ui?.notify?.(
          `Our Free Model: 已就绪 ${config.models.length} 个模型。\n` +
          `本地网关: ${service.url}\n` +
          `• 输入 /free-models open 可一键在浏览器打开毛玻璃账号管理后台\n` +
          `• 输入 /free-models update 可检查原作者最新上游更新`
        );
      } catch (error) {
        ctx.ui?.notify?.("Our Free Model 状态不可用: " + (error?.message ?? error));
      }
    },
  });

  return boot().catch((error) => {
    logger.warn?.("pi-our-free-model: could not start the gateway: " + (error?.message ?? error));
    return null;
  });
}
