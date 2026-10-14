/**
 * Local verification for the pinned snapshot.
 *
 * Two questions this answers, in order:
 *
 *   1. Does the bundled tree match its manifest? (bytes, hashes)
 *   2. Is the bundled tree self-contained? (every relative import resolves)
 *   3. Does the gateway actually boot from it? (spawn cli.mjs, wait /health,
 *      list /v1/models, shut it down)
 *
 * Question 3 is the one that matters. 1 and 2 are bookkeeping; 3 is what tells
 * you the pin is runnable rather than merely intact. It uses a throwaway data
 * directory so it never touches the user's real gateway state or port.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The same primitives the extension uses, imported from the delivered file so the
// verifier checks the code that actually ships rather than a parallel copy.
import {
  sha256,
  verifyClosure,
  cliEntryOf,
  webAssetsOf,
} from '../extensions/index.js'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundledRoot = path.join(projectRoot, 'bundled')

let failures = 0
const fail = (message) => { failures += 1; console.error('FAIL  ' + message) }
const pass = (message) => console.log('pass  ' + message)

function checkBytes() {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundledRoot, 'manifest.json'), 'utf8'))
  if (typeof manifest.revision !== 'string' || !/^[0-9a-f]{40}$/.test(manifest.revision)) {
    fail('manifest.revision is not a full sha')
    return null
  }
  let checked = 0
  for (const entry of manifest.files) {
    const file = path.join(bundledRoot, entry.path)
    if (!fs.existsSync(file)) { fail(`missing on disk: ${entry.path}`); continue }
    const bytes = fs.readFileSync(file)
    if (bytes.length !== entry.bytes) { fail(`size mismatch: ${entry.path}`); continue }
    if (sha256(bytes) !== entry.sha256) { fail(`sha256 mismatch: ${entry.path}`); continue }
    checked += 1
  }
  if (failures === 0) pass(`manifest verified: ${checked}/${manifest.files.length} files @ ${manifest.revision.slice(0, 10)}`)
  return manifest
}

function checkClosure() {
  const files = new Map()
  const manifest = JSON.parse(fs.readFileSync(path.join(bundledRoot, 'manifest.json'), 'utf8'))
  for (const entry of manifest.files) files.set(entry.path, fs.readFileSync(path.join(bundledRoot, entry.path)))
  const closure = verifyClosure(files)
  if (!closure.ok) {
    for (const problem of closure.problems) fail(`closure: ${problem}`)
  } else {
    pass(`closure resolves: ${closure.fileCount} modules`)
  }
}

function checkEntryPoints() {
  try {
    const entry = cliEntryOf(bundledRoot)
    pass('gateway entry: ' + path.relative(bundledRoot, entry))
  } catch (error) {
    fail(error.message)
  }
  try {
    const assets = webAssetsOf(bundledRoot)
    pass(`web assets: ${assets.length} files`)
    const missing = assets.filter(name => !fs.existsSync(path.join(bundledRoot, 'packages/standalone/web', name)))
    if (missing.length > 0) fail('asset listed but absent: ' + missing.join(', '))
  } catch (error) {
    fail(error.message)
  }
}

async function checkBoot() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-verify-'))
  const entry = cliEntryOf(bundledRoot)
  const child = spawn(process.execPath, [entry, '--port', '0', '--data-dir', dataDir, '--no-refresh'], {
    cwd: path.dirname(entry),
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })

  const port = await new Promise((resolve) => {
    const deadline = Date.now() + 60_000
    const poll = setInterval(() => {
      const settings = safeReadJson(path.join(dataDir, 'settings.json'))
      if (Number.isInteger(settings?.standalonePort) && settings.standalonePort > 0) {
        clearInterval(poll)
        resolve(settings.standalonePort)
      } else if (Date.now() > deadline) { clearInterval(poll); resolve(null) }
    }, 250)
  })

  if (port === null) {
    child.kill()
    fail('gateway never bound a port. stderr: ' + stderr.slice(-400))
    fs.rmSync(dataDir, { recursive: true, force: true })
    return
  }
  pass(`gateway bound 127.0.0.1:${port}`)

  const health = await getJson(`http://127.0.0.1:${port}/health`)
  if (health?.ok === true) pass(`health ok: ${health.service ?? 'unknown'} ${health.version ?? ''}`)
  else fail('health check failed')

  const settings = safeReadJson(path.join(dataDir, 'settings.json'))
  if (typeof settings?.forwardKey !== 'string' || settings.forwardKey === '') {
    fail('gateway did not mint a forward key')
  } else {
    const models = await getJson(`http://127.0.0.1:${port}/v1/models`, settings.forwardKey)
    if (Array.isArray(models?.data)) pass(`/v1/models answered: ${models.data.length} rows (no-refresh mode)`)
    else fail('/v1/models did not return a list')
  }

  const asset = await fetch(`http://127.0.0.1:${port}/assets/app.js`).then(r => r.ok ? r.text() : null).catch(() => null)
  if (asset) pass(`management console serves a bundle (${asset.length} bytes)`)
  else fail('management console did not serve /assets/app.js')

  child.kill()
  await new Promise((resolve) => setTimeout(resolve, 500))
  fs.rmSync(dataDir, { recursive: true, force: true })
}

function safeReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

async function getJson(url, key) {
  try {
    const response = await fetch(url, { headers: key ? { authorization: 'Bearer ' + key } : {} })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

console.log('bundled snapshot verification\n')
checkBytes()
checkClosure()
checkEntryPoints()
await checkBoot()

console.log('')
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
