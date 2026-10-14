/**
 * Exercise the /free-models command through its real handler.
 *
 * `pi -p "/free-models status"` cannot test this: -p sends the string to the
 * model, it does not run commands. The command is TUI-only, so the only way to
 * regression-test it is to register it against a stub pi and call the handler
 * the way the TUI would.
 */

import path from 'node:path'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
if (!target) {
  console.error('usage: node verify-command.mjs <path/to/extensions/index.js>')
  process.exit(1)
}

const mod = await import(pathToFileURL(path.resolve(target)).href)

const registered = { commands: [], providers: [] }
const notifications = []

const pi = {
  registerCommand(name, spec) { registered.commands.push({ name, ...spec }) },
  registerProvider(name, config) { registered.providers.push({ name, config }) },
  registerTool() {},
  registerShortcut() {},
  registerFlag() {},
  registerMcpServer() {},
  registerVirtualModel() {},
  on() { return () => {} },
  events: { on() { return () => {} }, emit() {} },
}

mod.default(pi)

if (registered.commands.length === 0) {
  console.error('FAIL: extension registered no commands')
  process.exit(1)
}

const command = registered.commands.find((c) => c.name === 'free-models')
if (!command) {
  console.error('FAIL: no /free-models command; got ' + registered.commands.map((c) => c.name).join(', '))
  process.exit(1)
}

const ctx = {
  ui: {
    notify(message) { notifications.push(String(message)) },
    confirm: async () => false,
    input: async () => '',
    select: async () => null,
  },
  cwd: process.cwd(),
}

let failures = 0
function check(label, ok, detail) {
  console.log(`${ok ? 'pass' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

/** Run one subcommand and return everything it said. */
async function run(sub) {
  notifications.length = 0
  await command.handler(sub, ctx)
  return notifications.join('\n')
}

console.log(`command: /${command.name}`)
console.log(`description: ${command.description}`)
console.log('')

// status is the default (empty args) and the most-used entry point.
const status = await run('')
check('status prints something', status.trim().length > 0, status.split('\n')[0]?.slice(0, 70))
check('status names the pinned revision', /[0-9a-f]{10}/.test(status))
check('status reports the cache directory', /cache|runtimes|snapshot/i.test(status))

const bare = await run(undefined)
check('bare invocation behaves like status', bare.trim().length > 0)

const runtimes = await run('runtimes')
check('runtimes prints something', runtimes.trim().length > 0, runtimes.split('\n')[0]?.slice(0, 70))

const refresh = await run('refresh')
check('refresh reports a model count', /models?|模型/i.test(refresh), refresh.slice(0, 70))
check('refresh re-registered the provider', registered.providers.length > 0, `${registered.providers.length} registration(s)`)

const updated = registered.providers.at(-1)
check('registration has a baseUrl', typeof updated?.config?.baseUrl === 'string', updated?.config?.baseUrl)
check('registration has models', (updated?.config?.models?.length ?? 0) > 0, `${updated?.config?.models?.length} models`)

// An unknown subcommand must not throw and must not silently do nothing.
const bogus = await run('definitely-not-a-subcommand')
check('unknown subcommand is answered, not ignored', bogus.trim().length > 0, bogus.split('\n')[0]?.slice(0, 70))

console.log('')
if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all command checks passed')
process.exit(0)
