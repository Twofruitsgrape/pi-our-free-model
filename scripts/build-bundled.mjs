/**
 * Build the bundled fallback manifest from an upstream checkout.
 *
 * Run this when bumping the pin. It walks a local clone of the upstream
 * repository at a specific revision, keeps exactly the files the gateway needs,
 * and emits two artifacts:
 *
 *   - a byte-for-byte copy of the tree under `bundled/`
 *   - `bundled/manifest.json`, the pin + per-file size and sha256
 *
 * The bundled copy exists so a first launch with no network still has a working
 * gateway. It is deliberately a *pinned* snapshot, never a rolling copy: the
 * whole point is that the version the user gets is the version that was
 * reviewed.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const bundledRoot = path.join(projectRoot, 'bundled')

import { SOURCE_PREFIXES } from './paths.mjs'

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

function walk(root, prefix, out) {
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) walk(root, rel, out)
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

const upstreamRoot = process.argv[2]
if (!upstreamRoot) {
  console.error('Usage: node scripts/build-bundled.mjs /path/to/upstream-checkout [revision]')
  process.exit(1)
}
if (!fs.existsSync(path.join(upstreamRoot, 'package.json'))) {
  console.error('Not an upstream checkout (no package.json): ' + upstreamRoot)
  process.exit(1)
}

let revision = process.argv[3]
if (!revision) {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: upstreamRoot, encoding: 'utf8' }).trim()
}

const all = []
for (const prefix of SOURCE_PREFIXES.filter(p => p.endsWith('/'))) walk(upstreamRoot, prefix.slice(0, -1), all)
for (const file of SOURCE_PREFIXES.filter(p => !p.endsWith('/'))) {
  if (fs.existsSync(path.join(upstreamRoot, file))) all.push(file)
}

const files = []
for (const rel of [...new Set(all)].sort()) {
  const bytes = fs.readFileSync(path.join(upstreamRoot, rel))
  files.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) })
}

const manifest = {
  repository: 'https://github.com/Ebony-Vinyl/dsh-our-free-model',
  revision,
  builtAt: new Date().toISOString(),
  upstreamVersion: readUpstreamVersion(upstreamRoot),
  files,
}

fs.rmSync(bundledRoot, { recursive: true, force: true })
fs.mkdirSync(bundledRoot, { recursive: true })
for (const rel of files.map(f => f.path)) {
  const destination = path.join(bundledRoot, rel)
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, fs.readFileSync(path.join(upstreamRoot, rel)))
}
fs.writeFileSync(path.join(bundledRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0)
console.log(`bundled ${files.length} files from ${revision.slice(0, 10)} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`)
console.log('fallback manifest written to ' + path.relative(projectRoot, bundledRoot))

function readUpstreamVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'packages', 'standalone', 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}
