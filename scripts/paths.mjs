/**
 * Upstream path policy — the single place that decides what a snapshot contains.
 *
 * Shared by the extension and every command-line tool so the two cannot drift:
 * a path added here is filtered identically at download time, in the bundled
 * fallback, and in the verifier.
 */

/**
 * Prefixes copied verbatim. A trailing slash marks a directory.
 *
 * Deliberately NOT included:
 *
 *   vendor/channel-pack/pack.js — 2.9 MiB, read only by upstream's *build*
 *     scripts (build-channel-pack.mjs) to regenerate channels/business.mjs.
 *     The running gateway never opens it.
 *   packages/standalone/frontend, tsconfig.json, vite.config.mjs — the
 *     React/Vite sources and build config; the gateway serves the prebuilt
 *     hashed bundles out of packages/standalone/web.
 *   scripts/, docs/, .github/, index.js, client.js, adapter/, feed/, catalog/,
 *     locale/, cordis.patch.yml — the DSH plugin half. None of it is reachable
 *     from the standalone entry point.
 *
 * The set below was derived by walking the import closure from
 * packages/standalone/cli.mjs: 57 modules, 0.61 MiB, every relative import
 * resolves. Anything outside it is unreachable by the gateway.
 */
export const SOURCE_PREFIXES = [
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

/** Rejected even when a prefix above would otherwise match. */
export const DENIED_PREFIXES = ['node_modules/', '.git/']

/** True when `relPath` belongs in a gateway snapshot. */
export function isListed(relPath) {
  if (DENIED_PREFIXES.some((prefix) => relPath.startsWith(prefix))) return false
  return SOURCE_PREFIXES.some((prefix) => relPath === prefix || relPath.startsWith(prefix))
}
