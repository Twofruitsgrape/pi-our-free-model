# NOTICE

## Upstream project

`pi-our-free-model` is a port of:

- **Project:** Our Free Model (`dsh-our-free-model`)
- **Author:** Ebony-Vinyl
- **Repository:** https://github.com/Ebony-Vinyl/dsh-our-free-model
- **License:** MIT (see `LICENSE` in this package, reproduced verbatim)

All credit for the model channels, the catalog, the gateway, the account and
credential handling and the standalone service belongs to the upstream author
and its contributors. This package adds the pi integration layer described below
and nothing else.

## What this package is

The upstream project is a plugin for **DeepSeek Harness (DSH)**. It declares a
`dsh` manifest, depends on `@deepseek-ai/*` packages as peers, and is loaded by
the DSH plugin host. Pi packages use a different contract — a `pi` manifest plus
extensions that call `pi.registerProvider()` — so the upstream package cannot be
installed into pi directly.

Upstream ships a variant that runs **without** DSH, Cordis, a DSH profile or DSH
credentials: `packages/standalone`, a local OpenAI-compatible gateway. This
package runs that gateway and registers it as a pi provider.

## How the gateway code reaches this package

`bundled/` holds one **pinned** snapshot of the upstream standalone closure:

- `bundled/manifest.json` — the revision, its per-file size and sha256, and the
  UTC time the snapshot was built.
- `bundled/**` — the byte-for-byte tree for that revision.

Updating is `node scripts/bump-pin.mjs <revision>` (or `--latest`), which
regenerates both artifacts from a fresh upstream checkout. The pin is reviewed
before it is written: see "Reviewing a pin" in README.md.

Nothing here relicenses or rewrites upstream. The files under `bundled/` are
unmodified upstream sources and remain under the upstream MIT license with their
original copyright notices. Third-party notices for the vendored channel pack
are preserved at `bundled/vendor/channel-pack/NOTICE.md`.

## What this package adds

1. `src/upstream.js` — downloads a revision, filters it to the gateway's import
   closure, verifies it, and stages it under `~/.our-free-model/runtimes/`.
   Nothing in this file executes upstream code; files are read as bytes, hashed
   and written.
2. `src/service.js` — spawns or adopts the gateway as a detached local process,
   including stale-lock recovery after an unclean shutdown.
3. `src/provider.js` — reads the gateway's own catalog to build pi's Model
   shape. Ids pass through unchanged; metadata comes from the gateway rather
   than from local guesses.
4. `src/extensions/index.js` — the pi extension: `pi.registerProvider(...)` and
   a `/free-models` command.

## Disclaimer

This port is not affiliated with, endorsed by, or supported by the upstream
author. Free third-party model channels are operated by the upstream project;
their availability, quotas and terms are outside the control of this package.
Some upstream channels state that prompts may be recorded to improve their
service — treat the free lanes as a supplement to a paid provider, not a
replacement, and do not send sensitive content through them.
