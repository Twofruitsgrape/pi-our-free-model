/**
 * pi-our-free-model — free frontier models for the pi coding agent.
 *
 * Ported from Ebony-Vinyl/dsh-our-free-model (MIT).
 * Original project: https://github.com/Ebony-Vinyl/dsh-our-free-model
 *
 * Self-contained on purpose: pi's -e flag loads one file and does not resolve
 * relative imports, so this extension is a single module. The npm package points
 * its pi.extensions at this same file, so installed and local behaviour match.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
/**
 * pi-our-free-model — free frontier models for the pi coding agent.
 *
 * Ported from Ebony-Vinyl/dsh-our-free-model (MIT).
 * Original project: https://github.com/Ebony-Vinyl/dsh-our-free-model
 *
 * This extension runs the upstream standalone gateway as a detached local
 * process and registers it as a pi provider. DeepSeek Harness (DSH) is NOT
 * required — no DSH, no Cordis, no profile, no credentials, no account.
 *
 * Architecture — "pin, don't vendor":
 *
 *   bundled/manifest.json    a reviewed upstream revision + per-file sha256
 *          │                 (ships inside this package)
 *          ├──► first launch: run the bundled tree, so it works offline
 *          └──► later launch: run the staged snapshot for the current pin
 *
 * The packaged tree is a *snapshot*, not a mirror. It exists so the first launch
 * never needs the network. `scripts/bump-pin.mjs <revision>` regenerates it, and
 * that one file — bundled/manifest.json — is the whole "how current is this"
 * question. Nothing here fetches in the background.
 *
 * Why the gateway runs out-of-process, in one line: it keeps a worker thread
 * and an HTTP listener alive, so embedded it would stop `pi -p "..."` from ever
 * exiting, and two pi sessions would share one account-pool singleton.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(__dirname, '..')
const BUNDLED_ROOT = path.join(PACKAGE_ROOT, 'bundled')

const PROVIDER_ID = 'our-free-model'
const ENTRY_REL_PATH = 'packages/standalone/cli.mjs'

/** Read by the CLI tools so there is exactly one spelling of the upstream. */
export const UPSTREAM_REPO = 'Ebony-Vinyl/dsh-our-free-model'
export const UPSTREAM_BRANCH = 'main'

/** The gateway's import closure, plus its web assets. Nothing else. */
const SOURCE_PREFIXES = [
  'packages/standalone/cli.mjs',
  'packages/standalone/service.mjs',
  'packages/standalone/management.mjs',
  'packages/standalone/login-terminal.mjs',
  'packages/standalone/eac.mjs',
  'packages/standalone/package.json',
  'packages/standalone/README.md',
  'packages/standalone/channels/',
  'packages/standalone/web/',
  'src/',
  'vendor/channel-pack/qoder-auth-wasm.wasm',
  'vendor/channel-pack/LICENSE',
  'vendor/channel-pack/NOTICE.md',
  'LICENSE',
]
const DENIED_PREFIXES = ['node_modules/', '.git/']

function isListed(relPath) {
  if (DENIED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false
  return SOURCE_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix))
}

export function sha256(bytes) {
  // sha256 over a Buffer; kept local so the module has no crypto import whose
  // only use is this.
  return createHash('sha256').update(bytes).digest('hex')
}

/** Data directory for the gateway; independent of any DSH directory. */
export function resolveDataDir() {
  const fromEnv = process.env.PI_OUR_FREE_MODEL_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.our-free-model')
}

/** Cache root holding one staged snapshot per revision. */
export function resolveCacheRoot() {
  const fromEnv = process.env.PI_OUR_FREE_MODEL_CACHE
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(resolveDataDir(), 'runtimes')
}

function snapshotDir(cacheRoot, revision) {
  return path.join(cacheRoot, 'snapshots', revision)
}

export function readBundledManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BUNDLED_ROOT, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/* ==== upstream download, verification, staging ==== */

/**
 * Parse a USTAR archive into `{relPath: bytes}`.
 *
 * Walked in memory rather than unpacked to disk, so an unexpected or hostile path
 * cannot escape the staging directory, and the allow-list is applied before a
 * byte is written.
 *
 * Accepts gzip input because codeload serves `application/x-gzip`. Handles the
 * GNU long-name (0x4c) headers GitHub emits for paths over 100 characters, which
 * the channel-pack sources do have.
 */
function readTar(tar) {
  const files = new Map()
  let pendingName = null
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = header.subarray(0, 100).toString('utf8')
    const name = rawName.replace(/\0.*$/, '')
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeField, 8) || 0
    const typeFlag = header[156]
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    offset += 512
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512

    if (typeFlag === 0x4c) {
      pendingName = body.toString('utf8').replace(/\0.*$/, '')
      continue
    }
    // pax per-file, pax global, directory, pax global extended
    if (typeFlag === 0x78 || typeFlag === 0x58 || typeFlag === 0x35 || typeFlag === 0x47) continue

    const baseName = pendingName ?? name
    pendingName = null
    const combined = prefix ? `${prefix}/${baseName}` : baseName
    if (combined === '' || combined === './') continue
    // Strip the leading `./` and the single top-level directory (`repo-sha/`).
    const relPath = combined.replace(/^\.\//, '').replace(/^[^/]+\//, '')
    if (!isListed(relPath)) continue
    if (!files.has(relPath)) files.set(relPath, Buffer.from(body))
  }
  return files
}

export function readTarball(tarballBuffer) {
  const tar = tarballBuffer.length > 2 && tarballBuffer[0] === 0x1f && tarballBuffer[1] === 0x8b
    ? zlib.gunzipSync(tarballBuffer)
    : tarballBuffer
  return readTar(tar)
}

/**
 * Walk every relative import reachable from the gateway entry point.
 *
 * This is what makes an unreviewed download checkable. Without a pinned manifest
 * the strongest honest statement is "the tree is closed": every module it claims
 * to import is present, so it is neither a truncated archive nor a tree with a
 * file silently dropped.
 */
export function verifyClosure(files) {
  const problems = []
  if (!files.has(ENTRY_REL_PATH)) return { ok: false, problems: [`missing entry: ${ENTRY_REL_PATH}`], fileCount: 0 }
  const seen = new Set()
  const queue = [ENTRY_REL_PATH]
  const importPattern = /(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g
  while (queue.length > 0) {
    const relPath = queue.shift()
    if (seen.has(relPath)) continue
    seen.add(relPath)
    const bytes = files.get(relPath)
    if (bytes === undefined) {
      problems.push(`unresolved import: ${relPath}`)
      continue
    }
    let match
    importPattern.lastIndex = 0
    while ((match = importPattern.exec(bytes.toString('utf8'))) !== null) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), match[1]))
      // Climbing out of the tree means the staged layout is not the layout the
      // code expects — the failure that otherwise shows up as an ENOENT at import.
      if (resolved.startsWith('..')) {
        problems.push(`escapes the staged tree: ${relPath} -> ${match[1]}`)
        continue
      }
      if (!seen.has(resolved)) queue.push(resolved)
    }
  }
  return { ok: problems.length === 0, problems, fileCount: seen.size }
}

/** Check a downloaded or bundled tree against a pinned manifest. */
export function verifySnapshot(files, manifest) {
  const problems = []
  for (const entry of manifest?.files ?? []) {
    const bytes = files.get(entry.path)
    if (bytes === undefined) {
      problems.push(`missing: ${entry.path}`)
      continue
    }
    if (bytes.length !== entry.bytes) {
      problems.push(`size mismatch: ${entry.path} (${bytes.length} != ${entry.bytes})`)
      continue
    }
    if (sha256(bytes) !== entry.sha256) problems.push(`sha256 mismatch: ${entry.path}`)
  }
  const closure = verifyClosure(files)
  if (!closure.ok) problems.push(...closure.problems)
  return problems
}

/**
 * Download the file set for one revision.
 *
 * The codeload tarball is preferred: one request, GitHub's own infrastructure,
 * and it is the exact tree for that commit rather than whatever the branch points
 * at now. One retry, because a transient failure should not cost the user a pin.
 */
export async function fetchUpstream(revision, { fetchImpl = fetch, signal } = {}) {
  const url = `https://codeload.github.com/${UPSTREAM_REPO}/tar.gz/${revision}`
  let lastError
  for (const attempt of [1, 2]) {
    const response = await fetchImpl(url, {
      signal,
      headers: { 'user-agent': 'pi-our-free-model-sync', accept: 'application/gzip' },
      redirect: 'follow',
    })
    if (response.ok) {
      const files = readTarball(Buffer.from(await response.arrayBuffer()))
      if (files.has(ENTRY_REL_PATH)) return files
      lastError = new Error('tarball contained no gateway entry point')
    } else {
      lastError = new Error(`upstream ${revision} returned HTTP ${response.status}`)
      // 404 means the revision does not exist; retrying cannot help.
      if (response.status === 404) break
    }
    if (attempt === 1 && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw lastError ?? new Error('upstream download failed')
}

/**
 * Atomically stage a verified snapshot.
 *
 * Written into a sibling staging directory and renamed only once complete, so a
 * crash mid-write cannot leave a half-populated tree that a later run mistakes
 * for a usable snapshot. The previous snapshot is kept until the rename succeeds
 * and restored if it does not.
 */
export function stageSnapshot(cacheRoot, revision, files) {
  const target = snapshotDir(cacheRoot, revision)
  if (fs.existsSync(path.join(target, '.complete'))) return { target, changed: false }

  const staging = `${target}.staging-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    for (const [relPath, bytes] of files) {
      const destination = path.join(staging, relPath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.writeFileSync(destination, bytes)
    }
    // Inside the staging tree on purpose: the marker must only ever exist in a
    // directory that already holds every file.
    fs.writeFileSync(path.join(staging, '.complete'), new Date().toISOString() + '\n', 'utf8')

    const previous = `${target}.previous-${process.pid}`
    if (fs.existsSync(target)) fs.renameSync(target, previous)
    try {
      fs.renameSync(staging, target)
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, target)
      throw error
    }
    fs.rmSync(previous, { recursive: true, force: true })
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return { target, changed: true }
}

/**
 * Resolve the gateway's CLI entry inside a staged tree.
 *
 * Read from the gateway package's own package.json rather than hard-coded, so an
 * upstream rename of cli.mjs surfaces as a clear error instead of an ENOENT from
 * deep inside spawn().
 */
export function cliEntryOf(snapshot) {
  let entry = 'cli.mjs'
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(snapshot, 'packages', 'standalone', 'package.json'), 'utf8'))
    const match = /([\w.-]+\.mjs)/.exec(pkg?.scripts?.start ?? '')
    if (match) entry = match[1]
  } catch {
    /* fall back to the conventional name; the existence check reports it */
  }
  const resolved = path.join(snapshot, 'packages', 'standalone', entry)
  if (!fs.existsSync(resolved)) {
    throw new Error(`gateway entry not found: ${path.relative(snapshot, resolved)}`)
  }
  return resolved
}

/**
 * Read the asset manifest the gateway's management layer serves from.
 *
 * management.mjs reads web/assets.json at runtime and refuses to serve anything
 * not named in it. Vite hashes the bundle names on every build, so this reads
 * the staged list instead of hard-coding one — otherwise the console would
 * silently serve a stale bundle after an upstream rebuild.
 */
export function webAssetsOf(snapshot) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(snapshot, 'packages', 'standalone', 'web', 'assets.json'), 'utf8'))
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string')) {
      throw new Error('assets.json is not a list of names')
    }
    return list
  } catch (error) {
    throw new Error(`cannot read web assets manifest: ${error.message}`)
  }
}

/** True when a staged snapshot is complete and has an identifiable entry point. */
export function isUsableSnapshot(snapshot) {
  try {
    cliEntryOf(snapshot)
    webAssetsOf(snapshot)
    if (!fs.existsSync(path.join(snapshot, '.complete'))) return false
    // The entry and the manifest existing is not enough: a partially deleted
    // cache would pass those and then fail at import time, which surfaces as a
    // gateway that never becomes healthy. Walking the closure turns that into a
    // detectable "unusable" here instead.
    const files = readSnapshotFiles(snapshot)
    if (files === null) return false
    return verifyClosure(files).ok
  } catch {
    return false
  }
}

/** Read a staged tree into the `{relPath: bytes}` shape the closure walker wants. */
function readSnapshotFiles(snapshot) {
  const files = new Map()
  const visit = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { visit(path.join(current, entry.name), childRel); continue }
      if (!entry.isFile()) continue
      if (!isListed(childRel)) continue
      files.set(childRel, fs.readFileSync(path.join(current, entry.name)))
    }
  }
  try {
    visit(snapshot, '')
    return files.size > 0 ? files : null
  } catch {
    return null
  }
}

/* ==== gateway process management ==== */

/** How long a cold gateway gets to answer /health before we call it failed. */
const HEALTH_TIMEOUT_MS = 60_000
const HEALTH_POLL_MS = 400

export function readSettings(dataDir) {
  try {
    const settingsPath = path.join(dataDir, 'settings.json')
    if (!fs.existsSync(settingsPath)) return undefined
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Reap a lock whose owner is gone.
 *
 * The gateway opens its lock with `wx`, so the lock file is the authority on who
 * owns the data directory. A process killed by the OS leaves a file that blocks
 * every later start — and after an unclean shutdown that is the most common
 * first-run failure there is.
 *
 * Returns false when the owner is genuinely alive: deleting the lock then would
 * give two gateways one data directory, which is worse than the error.
 */
export function clearStaleLock(dataDir, logger) {
  const lockFile = path.join(dataDir, 'service.lock')
  if (!fs.existsSync(lockFile)) return false
  let ownerAlive = false
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
    const pid = parsed?.pid
    if (typeof pid === 'number' && pid > 0) {
      try {
        process.kill(pid, 0)
        ownerAlive = pid !== process.pid
      } catch {
        ownerAlive = false
      }
    }
  } catch {
    ownerAlive = false
  }
  if (ownerAlive) return false
  try {
    fs.unlinkSync(lockFile)
    logger?.warn?.('pi-our-free-model: removed a stale service lock from a previous run.')
    return true
  } catch {
    return false
  }
}

async function probeHealth(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url + '/health', { signal: controller.signal })
    if (!response.ok) return false
    const body = await response.json()
    return body?.service === 'our-free-model-standalone' || body?.service === 'our-free-model'
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

async function waitForHealth(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let exited = false
  child.once('exit', () => { exited = true })
  while (Date.now() < deadline) {
    if (exited) return false
    if (await probeHealth(url)) return true
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS))
  }
  return false
}

/**
 * Start, or adopt, the gateway.
 *
 * Adoption is the common path. The gateway outlives pi and already holds a
 * catalog probed from this machine's egress; spawning a second one would waste
 * that work and contend for the data directory lock.
 */
export function ensureService({ cliEntry, dataDir, logger }) {
  return (async () => {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    if (!fs.existsSync(cliEntry)) {
      throw new Error('pi-our-free-model: gateway entry not found at ' + cliEntry + '. Reinstall the package.')
    }

    // A snapshot that exists but failed its completeness check is a partially
    // written cache. Refusing it here is far cheaper than debugging an ENOENT
    // three layers deeper.
    const runtimeRoot = path.resolve(path.dirname(cliEntry), '..', '..')
    if (runtimeRoot.includes(path.join('runtimes', 'snapshots')) && !isUsableSnapshot(runtimeRoot)) {
      throw new Error('pi-our-free-model: cached runtime is incomplete; delete ' + runtimeRoot)
    }

    const settings = readSettings(dataDir)
    const savedKey = settings?.forwardKey
    const savedPort = settings?.standalonePort

    if (typeof savedKey === 'string' && savedKey !== '' && Number.isInteger(savedPort) && savedPort > 0) {
      const existingUrl = 'http://127.0.0.1:' + savedPort
      if (await probeHealth(existingUrl)) {
        return { url: existingUrl, key: savedKey, dataDir, spawned: false, port: savedPort }
      }
    }

    const port = await findFreePort()
    const url = 'http://127.0.0.1:' + port

    // cwd is the gateway's own directory, not the package root: spawning inside
    // node_modules would make the child inherit pi's module resolution.
    const spawnOnce = () =>
      spawn(process.execPath, [cliEntry, '--port', String(port), '--data-dir', dataDir], {
        cwd: path.dirname(cliEntry),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, OFM_STANDALONE: '1' },
      })

    let child = spawnOnce()
    child.unref()

    let healthy = await waitForHealth(url, child, HEALTH_TIMEOUT_MS)

    if (!healthy && clearStaleLock(dataDir, logger)) {
      try { child.kill() } catch { /* already dead */ }
      child = spawnOnce()
      child.unref()
      healthy = await waitForHealth(url, child, HEALTH_TIMEOUT_MS)
    }

    if (!healthy) {
      throw new Error('pi-our-free-model: the local gateway did not become healthy on ' + url)
    }

    const finalKey = readSettings(dataDir)?.forwardKey ?? savedKey
    if (!finalKey) throw new Error('pi-our-free-model: could not determine the gateway API key')

    return { url, key: finalKey, dataDir, spawned: true, port }
  })()
}

/**
 * List the gateway's models.
 *
 * Returns undefined rather than [] on failure, because the caller must tell "the
 * gateway has not finished its first catalog refresh" from "the gateway is
 * empty" — only the first should keep waiting.
 */
export async function discoverModels(service, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(service.url + '/v1/models', {
      headers: { Authorization: 'Bearer ' + service.key },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const body = await response.json()
    if (!Array.isArray(body?.data)) return undefined
    const entries = body.data
      .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
      .map((entry) => ({
        id: entry.id,
        contextWindow: Number.isFinite(entry.context_window) ? entry.context_window : undefined,
      }))
    return entries.length > 0 ? entries : undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read the gateway's catalog for metadata /v1/models does not carry.
 *
 * maxOutput, reasoning and vision per model exist nowhere else, and this is one
 * local read rather than N probes.
 */
export function readCatalogMeta(dataDir) {
  const meta = new Map()
  try {
    const catalogPath = path.join(dataDir, 'catalog.json')
    if (!fs.existsSync(catalogPath)) return meta
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
    for (const row of Array.isArray(catalog?.kiloRows) ? catalog.kiloRows : []) {
      if (typeof row?.id !== 'string') continue
      meta.set(row.id, {
        name: typeof row.name === 'string' ? row.name : undefined,
        contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : undefined,
        maxOutput: Number.isFinite(row.maxOutput) ? row.maxOutput : undefined,
        reasoning: row.reasoning !== false,
        vision: row.vision === true,
      })
    }
  } catch {
    /* a catalog written mid-refresh reads as empty; callers have fallbacks */
  }
  return meta
}

/**
 * Wait for the full catalog rather than the first answer.
 *
 * The free lane answers immediately; the account channels report in behind it.
 * Returning on the first response would register ~7 models and hide the other
 * ~650.
 */
export async function waitForFullCatalog(service, { attempts = 15, delayMs = 1000 } = {}) {
  let best
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await discoverModels(service, 20_000)
    if (found && found.length > 0) {
      best = found
      if (found.length > 100) return found
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return best
}

/* ==== model discovery and the pi provider registration ==== */

/**
 * Static list used only until the gateway answers its first /v1/models.
 *
 * Deliberately short. This is not a catalog — it is the difference between a
 * usable /model picker on a cold start and an empty one.
 */
const FALLBACK_MODELS = [
  { id: 'stealth/glyph-cluster', name: 'Glyph Cluster', contextWindow: 256_000 },
  { id: 'openrouter/free', name: 'OpenRouter Free', contextWindow: 200_000 },
  { id: 'inclusionai/ling-3.1-flash', name: 'Ling 3.1 Flash', contextWindow: 262_144 },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo v2.6 Flash', contextWindow: 128_000 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning', contextWindow: 128_000 },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview', contextWindow: 128_000 },
]

/**
 * Models the gateway lists but cannot drive a chat turn.
 *
 * The catalog carries probe and local-helper lanes. Advertising one in /model
 * would invite a turn that ends in a canned string.
 */
const NON_CHAT_MODEL_IDS = new Set(['jev-1.13-free', 'exo-free'])

/** Channel prefixes the gateway uses, spelled the way upstream's docs do. */
const CHANNEL_LABELS = {
  workbuddy: 'WorkBuddy',
  buddy: 'CodeBuddy',
  lobsterai: 'LobsterAI',
  qoder: 'Qoder',
  qodercn: 'Qoder CN',
  codearts: 'CodeArts',
  cline: 'Cline',
  loomy: 'Loomy',
  raccoon: 'Raccoon',
  minimax: 'MiniMax',
  zcode: 'ZCode',
  gemini: 'Gemini',
  codeassist: 'CodeAssist',
  kilo: 'Kilo',
  opencode: 'OpenCode',
  free: 'free pool',
}

export function normalizeModelId(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return raw
  const parts = raw.split('/')
  if (parts.length > 1 && (parts[0] === 'our-free-model' || parts[0] === 'our-free-model-standalone')) {
    return parts.slice(1).join('/')
  }
  return raw
}

/**
 * Build the display name.
 *
 * pi groups rows by provider, so the channel has to be visible in the row itself
 * or the user cannot tell which of six "Ling" entries is which. The multiplier
 * suffix comes from the upstream catalog's own pricing string rather than from a
 * local rule, so it stays true when upstream changes its pricing.
 */
function formatModelDisplayName(entry, meta) {
  const id = entry.id
  const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
  const info = meta?.get ? (meta.get(entry.id) ?? meta.get(id)) : null

  const parts = id.split('/')
  const channel = parts.length > 1 ? parts[0] : ''
  const subName = parts.length > 1 ? parts.slice(1).join('/') : id
  const channelLabel = CHANNEL_LABELS[channel.toLowerCase()] ?? channel

  let tag = ''
  if (id.endsWith('-free') || id.includes('/free') || rawName.includes('免费') || rawName.includes('x0.00')) {
    tag = 'free'
  } else {
    const match = rawName.match(/x\d+(?:\.\d+)?/i)
    if (match) tag = match[0]
  }

  let cleanName = (info?.name || rawName).replace(/·\s*(?:x\d+(?:\.\d+)?|免费|x0\.00→免费).*$/i, '').trim()
  if (!cleanName || cleanName === subName) {
    cleanName = subName
      .split('/')
      .pop()
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (character) => character.toUpperCase())
      .replace(/\s*Free\b/i, '')
  }

  const label = channelLabel ? `[${channelLabel}] ${cleanName}` : cleanName
  return tag ? `${label} · ${tag}` : label
}

function toPiModel(entry, meta) {
  const id = normalizeModelId(entry.id)
  const info = meta?.get ? (meta.get(entry.id) ?? meta.get(id)) : null
  const contextWindow = info?.contextWindow ?? entry.contextWindow ?? 128_000
  const maxTokens = Math.min(info?.maxOutput ?? 32_000, contextWindow)
  return {
    id,
    name: formatModelDisplayName(entry, meta),
    reasoning: info?.reasoning !== false,
    input: info?.vision ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: maxTokens > 0 ? maxTokens : 32_000,
    compat: {
      // Both are asserted by upstream's own request builder, not observed here:
      // the gateway rejects OpenAI's `developer` role and reads `max_tokens`.
      supportsDeveloperRole: false,
      supportsFinishReason: false,
      maxTokensField: 'max_tokens',
    },
  }
}

function collectModels(discovered, meta) {
  const byId = new Map()
  for (const model of FALLBACK_MODELS) byId.set(model.id, toPiModel(model, meta))
  for (const entry of discovered ?? []) {
    if (NON_CHAT_MODEL_IDS.has(entry.id)) continue
    const model = toPiModel(entry, meta)
    byId.set(model.id, model)
  }
  return [...byId.values()]
}

/**
 * Build the provider config.
 *
 * One object, rebuilt wholesale. A partial patch would leave stale rows in pi's
 * picker, and re-registering is cheap enough that a top-up is safe rather than a
 * race.
 */
export async function buildProviderConfig(service, logger, { preloaded } = {}) {
  const meta = readCatalogMeta(service.dataDir)
  const discovered = preloaded ?? (await waitForFullCatalog(service))
  const models = collectModels(discovered, meta)
  return {
    baseUrl: service.url + '/v1',
    apiKey: service.key,
    api: 'openai-completions',
    models,
  }
}

/* ==== runtime resolution ==== */

/**
 * Resolve the gateway code to run.
 *
 * Order matters and is deliberate:
 *
 *   1. a complete cached snapshot for the current pin — the normal path after
 *      the first launch;
 *   2. the bundled tree copied into the cache — the offline path. Staging it
 *      rather than running in place keeps the gateway out of node_modules,
 *      where a concurrent `pi update` would delete files from under a live
 *      process;
 *   3. the bundled tree in place — only if the home directory is not writable.
 *
 * Returning the bundled root in step 3 is safe: the gateway is spawned with an
 * explicit --data-dir and never writes into its own source tree.
 */
export function resolveRuntime({ cacheRoot } = {}) {
  const manifest = readBundledManifest()
  const root = cacheRoot ?? resolveCacheRoot()

  if (manifest?.revision) {
    const cached = snapshotDir(root, manifest.revision)
    if (isUsableSnapshot(cached)) return { root: cached, source: 'cache', revision: manifest.revision }
  }

  if (manifest?.files) {
    try {
      const files = new Map()
      for (const entry of manifest.files) {
        files.set(entry.path, fs.readFileSync(path.join(BUNDLED_ROOT, entry.path)))
      }
      const problems = verifySnapshot(files, manifest)
      if (problems.length === 0) {
        const staged = stageSnapshot(root, manifest.revision, files)
        return { root: staged.target, source: 'bundled-staged', revision: manifest.revision }
      }
    } catch {
      /* fall through to running the bundled tree in place */
    }
  }

  return { root: BUNDLED_ROOT, source: 'bundled', revision: manifest?.revision ?? null }
}

/**
 * Pull a new revision into the cache.
 *
 * Reachable only through an explicit `/free-models update`. Nothing fetches
 * silently in the background, and a revision outside the manifest is verified by
 * closure rather than by hash — a weaker guarantee, which is exactly why this
 * path is opt-in and why failing here never touches the running gateway.
 */
export async function materializeRevision(revision, { cacheRoot, fetchImpl = fetch, logger } = {}) {
  const root = cacheRoot ?? resolveCacheRoot()
  try {
    const files = await fetchUpstream(revision, { fetchImpl })
    const closure = verifyClosure(files)
    if (!closure.ok) {
      throw new Error(`upstream ${revision} is not self-contained: ${closure.problems.slice(0, 3).join('; ')}`)
    }
    const staged = stageSnapshot(root, revision, files)
    logger?.info?.(`pi-our-free-model: staged upstream ${revision.slice(0, 10)} (${closure.fileCount} files)`)
    return { ok: true, target: staged.target, changed: staged.changed, revision, fileCount: closure.fileCount }
  } catch (error) {
    logger?.warn?.(`pi-our-free-model: could not materialize ${revision.slice(0, 10)}: ${error.message}`)
    return { ok: false, error: error.message }
  }
}

/* ==== the pi extension ==== */

function openBrowser(url) {
  const start = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(start, [url], { detached: true, stdio: 'ignore', windowsHide: true, shell: process.platform === 'win32' }).unref()
}

export default function registerOurFreeModel(pi) {
  const logger = {
    debug: (message) => pi.logger?.debug?.(message),
    info: (message) => pi.logger?.info?.(message),
    warn: (message) => pi.logger?.warn?.(message),
  }

  let runtime
  let cliEntry
  let assets = []
  try {
    runtime = resolveRuntime()
    cliEntry = cliEntryOf(runtime.root)
    assets = webAssetsOf(runtime.root)
  } catch (error) {
    logger.warn?.('pi-our-free-model: ' + error.message)
    return
  }

  const service = ensureService({ cliEntry, dataDir: resolveDataDir(), logger })

  let ready = null
  const boot = async () => {
    if (ready) return ready
    ready = (async () => {
      const running = await service
      const config = await buildProviderConfig(running, logger)
      pi.registerProvider(PROVIDER_ID, config)
      logger.info?.(
        `pi-our-free-model: ${config.models.length} model(s) via ${config.baseUrl} ` +
        `(gateway ${runtime.source} @ ${runtime.revision?.slice(0, 10) ?? 'unknown'}, ${assets.length} web assets)`,
      )

      // The free lane answers first and the account channels report in behind
      // it, so a cold start registers a short list and then fills out.
      if (config.models.length < 50) {
        setTimeout(async () => {
          try {
            const full = await waitForFullCatalog(running)
            if (full && full.length > config.models.length) {
              const topped = await buildProviderConfig(running, logger, { preloaded: full })
              if (topped.models.length > config.models.length) {
                pi.registerProvider(PROVIDER_ID, topped)
                logger.info?.(`pi-our-free-model: top-up complete — ${topped.models.length} models`)
              }
            }
          } catch {
            /* the gateway keeps running; the next start refreshes the list */
          }
        }, 8000).unref?.()
      }

      return { service: running, config }
    })().catch((error) => {
      ready = null
      throw error
    })
    return ready
  }

  pi.registerCommand('free-models', {
    description: 'Our Free Model 状态 / 刷新 / 更新 (free-models [status|refresh|update|open|runtimes])',
    handler: async (args, ctx) => {
      const sub = (args || '').trim().toLowerCase()
      try {
        const state = await boot()
        const { service: running, config } = state

        if (sub === 'open' || sub === 'ui' || sub === 'login') {
          openBrowser(running.url)
          ctx.ui?.notify?.(`管理面板: ${running.url}\nAPI Key: ${running.key}`)
          return
        }

        if (sub === 'refresh' || sub === 'reload') {
          const full = await waitForFullCatalog(running)
          const updated = await buildProviderConfig(running, logger, { preloaded: full })
          pi.registerProvider(PROVIDER_ID, updated)
          ctx.ui?.notify?.(`已刷新，当前 ${updated.models.length} 个模型。`)
          return
        }

        if (sub === 'update' || sub === 'check') {
          const response = await fetch(
            `https://api.github.com/repos/${UPSTREAM_REPO}/commits/main`,
            { headers: { 'user-agent': 'pi-our-free-model' }, signal: AbortSignal.timeout(8000) },
          ).catch(() => null)
          if (!response?.ok) {
            ctx.ui?.notify?.('检查上游更新失败（网络或 GitHub API 限制）。')
            return
          }
          const latest = (await response.json()).sha
          if (latest === runtime.revision) {
            ctx.ui?.notify?.(`已是最新 pin: ${String(runtime.revision).slice(0, 10)}`)
            return
          }
          const result = await materializeRevision(latest, { logger })
          if (result.ok) {
            ctx.ui?.notify?.(
              `已拉取上游 ${latest.slice(0, 10)}（${result.fileCount} 个文件）并放入缓存。\n` +
              `重启 pi 后生效；当前会话仍跑 ${String(runtime.revision).slice(0, 10)}。`,
            )
          } else {
            ctx.ui?.notify?.(`拉取失败: ${result.error}`)
          }
          return
        }

        if (sub === 'runtimes') {
          const cacheRoot = resolveCacheRoot()
          const snapshots = snapshotDir(cacheRoot, '')
          const installed = fs.existsSync(snapshots)
            ? fs.readdirSync(snapshots).filter((name) => !name.includes('.staging-') && !name.includes('.previous-')).sort()
            : []
          ctx.ui?.notify?.(
            `当前: ${runtime.source} @ ${runtime.revision?.slice(0, 10)}\n` +
            `缓存: ${snapshots}\n` +
            `已缓存 pin: ${installed.length === 0 ? '(无)' : installed.join(', ')}\n` +
            `web 资源: ${assets.length} 个文件`,
          )
          return
        }

        ctx.ui?.notify?.(
          `Our Free Model 就绪：${config.models.length} 个模型\n` +
          `网关: ${running.url}  (${runtime.source} @ ${runtime.revision?.slice(0, 10)})\n` +
          `• /free-models open      打开管理面板\n` +
          `• /free-models refresh   刷新模型清单\n` +
          `• /free-models update    检查并拉取上游新提交\n` +
          `• /free-models runtimes  查看运行时缓存`,
        )
      } catch (error) {
        ctx.ui?.notify?.('Our Free Model 不可用: ' + (error?.message ?? error))
      }
    },
  })

  return boot().catch((error) => {
    logger.warn?.('pi-our-free-model: could not start the gateway: ' + (error?.message ?? error))
    return null
  })
}
