/**
 * Bump the upstream pin and rebuild the bundled fallback.
 *
 * Two artifacts move together, and that is the whole mechanism:
 *
 *   1. bundled/manifest.json — the reviewed revision, per-file sizes and sha256
 *   2. bundled/**            — the byte-for-byte tree for that revision
 *
 * The pin lives in bundled/manifest.json and nowhere else, so "how current is
 * this package" is a one-file question and moving it forward is a one-command
 * change. Nothing about the gateway is forked: the code under bundled/ is
 * upstream's, verified byte-for-byte at build time.
 *
 * Usage:
 *   node scripts/bump-pin.mjs --check           report how far behind the pin is
 *   node scripts/bump-pin.mjs --latest          adopt upstream main
 *   node scripts/bump-pin.mjs <revision>        adopt a specific commit (7-40 hex)
 *   node scripts/bump-pin.mjs --current         re-stage the pin that is already there
 *
 * The upstream clone is left in `.upstream/` so the revision can be read before
 * the manifest is rewritten — "which commit am I adopting" should be answerable
 * by looking at the diff, not by trusting this script.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { UPSTREAM_REPO, UPSTREAM_BRANCH } from '../extensions/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '..')
const bundledRoot = path.join(projectRoot, 'bundled')
const upstreamDir = path.join(projectRoot, '.upstream')

/** Run git with its arguments as a real argv, never a shell string. */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function readCurrentPin() {
  try {
    const revision = JSON.parse(fs.readFileSync(path.join(bundledRoot, 'manifest.json'), 'utf8')).revision
    return typeof revision === 'string' ? revision : null
  } catch {
    return null
  }
}

function ensureClone() {
  if (fs.existsSync(path.join(upstreamDir, '.git'))) return
  fs.rmSync(upstreamDir, { recursive: true, force: true })
  // blob:none fetches trees and blobs on demand: a shallow checkout of a 13 MB
  // repository should not mean a 1 GB clone.
  run('git', ['clone', '--filter=blob:none', '--no-checkout', `https://github.com/${UPSTREAM_REPO}`, upstreamDir])
}

function upstreamHead() {
  ensureClone()
  run('git', ['-C', upstreamDir, 'fetch', '--quiet', 'origin', UPSTREAM_BRANCH])
  return run('git', ['-C', upstreamDir, 'rev-parse', `origin/${UPSTREAM_BRANCH}`]).trim()
}

function describeRevision(revision) {
  try {
    return {
      message: run('git', ['-C', upstreamDir, 'log', '-1', '--format=%s', revision]).trim(),
      author: run('git', ['-C', upstreamDir, 'log', '-1', '--format=%an', revision]).trim(),
      date: run('git', ['-C', upstreamDir, 'log', '-1', '--format=%cI', revision]).trim(),
    }
  } catch {
    return { message: '(unknown)', author: '', date: '' }
  }
}

function commitsBetween(from, to) {
  try {
    const output = run('git', ['-C', upstreamDir, 'log', '--oneline', `${from}..${to}`])
    return output.split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

const flag = process.argv[2]
const args = process.argv.slice(3)

if (flag === '--check') {
  const pin = readCurrentPin()
  if (!pin) {
    console.error('No bundled pin found. Build one first with --latest.')
    process.exit(1)
  }
  const head = upstreamHead()
  console.log(`pin:     ${pin}`)
  console.log(`upstream: ${head} (${UPSTREAM_REPO}@${UPSTREAM_BRANCH})`)
  if (head === pin) {
    console.log(`\nup to date with ${describeRevision(head).message}`)
    process.exit(0)
  }
  const between = commitsBetween(pin, head)
  console.log(`\n${between.length} unreviewed commit(s):`)
  for (const line of between.slice(0, 25)) console.log('  ' + line)
  if (between.length > 25) console.log(`  … and ${between.length - 25} more`)
  console.log(`\nreview with: git -C .upstream log --stat ${pin}..${head}`)
  console.log(`adopt with:   node scripts/bump-pin.mjs ${head}`)
  process.exit(between.length > 0 ? 2 : 0)
}

let revision
if (flag === '--latest') {
  revision = upstreamHead()
} else if (flag === '--current') {
  revision = readCurrentPin()
  if (!revision) {
    console.error('No bundled pin to re-stage.')
    process.exit(1)
  }
} else if (flag && /^[0-9a-f]{7,40}$/.test(flag)) {
  ensureClone()
  revision = run('git', ['-C', upstreamDir, 'rev-parse', flag]).trim()
} else {
  console.error('Usage: node scripts/bump-pin.mjs <--check|--latest|--current|<revision>> [--force]')
  process.exit(1)
}

const previous = readCurrentPin()
const description = describeRevision(revision)
console.log(`adopting ${revision}`)
console.log(`  ${description.message}`)
console.log(`  ${description.author}${description.date ? ' · ' + description.date : ''}`)

if (previous === revision && !args.includes('--force')) {
  console.log('already at this pin; pass --force to re-stage')
  process.exit(0)
}

if (previous) {
  const between = commitsBetween(previous, revision)
  if (between.length > 0) {
    console.log(`\n${between.length} commit(s) since the current pin:`)
    for (const line of between.slice(0, 15)) console.log('  ' + line)
    if (between.length > 15) console.log(`  … and ${between.length - 15} more`)
    console.log(`full diff: git -C .upstream log --stat ${previous}..${revision}`)
  }
}

// Materialize exactly this revision before writing the manifest, so a bad
// network or a wrong revision fails before the pin claims to have moved.
run('git', ['-C', upstreamDir, 'checkout', '--quiet', revision])

process.stdout.write(
  execFileSync(process.execPath, [path.join(here, 'build-bundled.mjs'), upstreamDir, revision], { encoding: 'utf8' }),
)

const manifest = JSON.parse(fs.readFileSync(path.join(bundledRoot, 'manifest.json'), 'utf8'))
const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0)
console.log(`\npin:     ${previous ? previous.slice(0, 10) : '(none)'} → ${revision.slice(0, 10)}`)
console.log(`files:   ${manifest.files.length} (${(totalBytes / 1024 / 1024).toFixed(1)} MiB)`)

console.log('\nverify with: node scripts/verify-bundled.mjs')
console.log(`then:        git add bundled && git commit -m "pin: upstream ${revision.slice(0, 10)}"`)
