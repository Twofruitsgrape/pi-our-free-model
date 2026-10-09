/**
 * pi-our-free-model - free frontier models for the pi coding agent.
 *
 * Ported from Ebony-Vinyl/dsh-our-free-model (MIT).
 * Original project: https://github.com/Ebony-Vinyl/dsh-our-free-model
 *
 * The original project is a DeepSeek Harness plugin. This package reuses its
 * "standalone" local service - a self-contained OpenAI-compatible gateway - and
 * registers it as a pi provider. DeepSeek Harness, Cordis, a DSH profile and
 * DSH credentials are NOT required: the gateway runs as a detached local
 * process, binds loopback only, and keeps its own data directory.
 *
 * The gateway runs out-of-process on purpose. Its channel runtime uses a worker
 * thread plus an HTTP listener, either of which would pin pi's event loop and
 * stop one-shot runs (`pi -p ...`) from ever exiting.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const CLI_ENTRY = path.join(PACKAGE_ROOT, "vendor", "packages", "standalone", "cli.mjs");

const PROVIDER_ID = "our-free-model";

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

/**
 * Strip a possibly host-prefixed model id down to what the gateway expects.
 * The gateway resolves "provider/model"; a leading "our-free-model/" prefix is
 * not part of its own ids.
 */
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

/**
 * The upstream service takes an exclusive lock file and never clears it after an
 * unclean exit, which would block every later start. Since pi starts and stops
 * often, recover from a lock whose owning process is gone.
 */
export function clearStaleLock(dataDir, logger) {
  const lockFile = path.join(dataDir, "service.lock");
  if (!fs.existsSync(lockFile)) return false;
  let ownerAlive = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const pid = parsed?.pid;
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid, 0); // signal 0 only probes for existence
        ownerAlive = pid !== process.pid;
      } catch {
        ownerAlive = false;
      }
    }
  } catch {
    ownerAlive = false; // an unreadable lock counts as stale
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

/** Probe a loopback port for the gateway's /health endpoint. */
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

/** Find a free loopback port. */
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

/**
 * Wait until the gateway answers /health, or the child dies.
 * Resolves true when healthy, false on timeout.
 */
async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) return false;
    if (await probeHealth(url)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/**
 * Ensure a gateway is running and return its connection details.
 *
 * Idempotent within a process: repeated calls share one promise. It first tries
 * to adopt an already-running gateway (so a second pi process, or a manually
 * started service, is reused rather than duplicated), then spawns a detached
 * child. The child is intentionally NOT killed when pi exits: it is a shared
 * local service, it is cheap while idle, and leaving it up makes the next pi
 * start instant. Use the /free-models command for status.
 */
let servicePromise = null;
export async function ensureService(logger) {
  if (servicePromise) return servicePromise;
  servicePromise = (async () => {
    const dataDir = resolveDataDir();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const settings = readSettings(dataDir);
    const key = settings?.forwardKey;
    const savedPort = settings?.standalonePort;

    // 1. Adopt an existing gateway when the saved port is live.
    if (typeof key === "string" && key !== "" && Number.isInteger(savedPort) && savedPort > 0) {
      const existingUrl = "http://127.0.0.1:" + savedPort;
      if (await probeHealth(existingUrl)) {
        return { url: existingUrl, key, dataDir, spawned: false };
      }
    }

    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(
        "pi-our-free-model: bundled service not found at " +
          CLI_ENTRY +
          ". Reinstall the package (vendor/ must ship with it).",
      );
    }

    // 2. Spawn the gateway as a detached child on a known free port.
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

    // 3. One recovery attempt for the known stale-lock failure.
    if (!healthy) {
      if (clearStaleLock(dataDir, logger)) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        child = spawnOnce();
        child.unref();
        healthy = await waitForHealth(url, child, 45000);
      }
    }

    if (!healthy) {
      throw new Error(
        "pi-our-free-model: the local gateway did not become healthy on " +
          url +
          ". Check that port " +
          port +
          " is free and retry.",
      );
    }

    const finalKey = readSettings(dataDir)?.forwardKey ?? key;
    if (!finalKey) {
      throw new Error("pi-our-free-model: could not determine the gateway API key");
    }
    return { url, key: finalKey, dataDir, spawned: true };
  })().catch((error) => {
    servicePromise = null; // allow a later retry
    throw error;
  });
  return servicePromise;
}

/** Ask the running gateway which models it currently offers. */
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

/**
 * The gateway's catalog carries richer per-model metadata (context window,
 * output limit, reasoning, vision) than /v1/models. Merge it in when available.
 */
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
  } catch {
    /* metadata is optional */
  }
  return meta;
}

/** Models the gateway lists but cannot serve as chat (classifiers, retired ids). */
const NON_CHAT_MODEL_IDS = new Set(["jev-1.13-free", "exo-free"]);

function humanizeModelId(id) {
  const tail = String(id).split("/").pop() ?? String(id);
  const spaced = tail.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return spaced.replace(/\s*Free\b/, " (free)").trim();
}

/** Turn a discovered gateway model into a pi model descriptor. */
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
      // The gateway rejects OpenAI's "developer" role and expects max_tokens.
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  };
}

/**
 * On a brand-new data directory the gateway has no catalog yet and reports an
 * empty (or nearly empty) model list for the first few seconds. Registering only
 * that would make pi warn "model not found" and fall back to a raw model id on a
 * fresh install. Poll until the roster is populated, bounded by a deadline.
 */
async function discoverModelsWhenReady(service, logger, { attempts = 12, delayMs = 2000 } = {}) {
  let best;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await discoverModels(service, 20000);
    if (found && found.length > 0) {
      best = found;
      // A cold catalog first returns just the anonymous set; wait one more beat
      // for the channel roster to settle, then accept whatever we have.
      if (found.length >= FALLBACK_MODELS.length || attempt >= 3) return found;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (best) return best;
  return undefined;
}

/** Build the pi provider config from a resolved service. */
export async function buildProviderConfig(service, logger) {
  const discovered = await discoverModelsWhenReady(service, logger);
  const meta = readCatalogMeta(service.dataDir);

  // Always include the bundled catalog as a floor, then layer the live roster on
  // top. This keeps a fresh install usable even if discovery is slow or partial.
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
  } else {
    logger?.warn?.(
      "pi-our-free-model: live model discovery returned nothing; using the bundled catalog. " +
        "The gateway may still be starting up.",
    );
  }

  return {
    baseUrl: service.url + "/v1",
    apiKey: service.key,
    api: "openai-completions",
    models: [...byId.values()],
  };
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
          "pi-our-free-model: " +
            config.models.length +
            " free model(s) via " +
            config.baseUrl +
            (service.spawned ? " (gateway started)" : " (gateway reused)"),
        );
        return { service, config };
      })();
    }
    return ready;
  };

  pi.registerCommand("free-models", {
    description: "Show the status of the Our Free Model gateway (free frontier models)",
    handler: async (_args, ctx) => {
      try {
        const state = await boot();
        const service = state.service;
        const config = state.config;
        ctx.ui?.notify?.(
          "Our Free Model: " +
            config.models.length +
            " model(s) at " +
            service.url +
            " (data: " +
            service.dataDir +
            ")",
        );
        logger.info?.(
          "Our Free Model gateway: " +
            service.url +
            (service.spawned ? " (started by this session)" : " (already running)") +
            "\n  data dir : " +
            service.dataDir +
            "\n  models   : " +
            config.models.length +
            "\n" +
            config.models.map((m) => "    - " + m.id).join("\n"),
        );
      } catch (error) {
        ctx.ui?.notify?.("Our Free Model is unavailable: " + (error?.message ?? error));
      }
    },
  });

  // Start the gateway now so its models are available to startup model
  // selection (pi awaits async extension factories before continuing).
  return boot().catch((error) => {
    logger.warn?.("pi-our-free-model: could not start the gateway: " + (error?.message ?? error));
    return null;
  });
}
