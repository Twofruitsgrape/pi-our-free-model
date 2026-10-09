# NOTICE

## Upstream project

`pi-our-free-model` is an independent port of:

- **Project:** Our Free Model (`dsh-our-free-model`)
- **Author:** Ebony-Vinyl
- **Repository:** https://github.com/Ebony-Vinyl/dsh-our-free-model
- **License:** MIT (see `LICENSE` in this package, reproduced verbatim)
- **Upstream revision used:** `befe36559e9f642ddac279e8b275558367f9f085` (2026-10-08)

All credit for the original work — the provider/channel integrations, the model
catalog, the request/stream conversion, the account and credential handling, and
the standalone local gateway — belongs to the upstream author and its
contributors. This port only adds the pi integration layer described below.

## What this port changes

The upstream project is a plugin for **DeepSeek Harness (DSH)**. It declares a
`dsh` manifest in `package.json`, depends on `@deepseek-ai/*` packages as peers,
and is loaded by the DSH plugin host.

pi packages use a different contract: a `pi` manifest in `package.json` plus
extensions that call `pi.registerProvider()`. The two plugin APIs are unrelated,
so the upstream package cannot be installed into pi directly.

This package therefore:

1. **Vendors the upstream `standalone` product** under `vendor/`. The upstream
   project already ships this variant specifically to run *without* DSH, Cordis,
   a DSH profile, or DSH credentials. It is used unmodified except for the one
   additive patch noted below.
2. **Adds `extensions/index.js`**, a pi extension that:
   - starts (or adopts) the vendored gateway as a detached local process,
   - discovers the available models from its `/v1/models` endpoint,
   - enriches them with metadata from the gateway catalog (`contextWindow`,
     `maxOutput`, `reasoning`, `vision`),
   - registers them with pi via `pi.registerProvider("our-free-model", ...)`,
   - sets the two compatibility flags this gateway needs
     (`supportsDeveloperRole: false`, `maxTokensField: "max_tokens"`),
   - adds a `/free-models` status command.
3. **Patches `vendor/packages/standalone/service.mjs`** (additive only): the
   service's return value now also exposes the raw `server` handle
   (`server: listener.server`). The standalone CLI ignores it and behaves
   exactly as upstream. This exists so an embedder can `unref()` the listener.

### Why the gateway runs out-of-process

An early version embedded the gateway in-process. That does not work well inside
pi: the gateway's channel runtime uses a worker thread and an HTTP listener, and
either keeps pi's event loop alive, so one-shot runs (`pi -p "..."`) never exit.
Running the gateway as a detached child process fixes this and also lets several
pi processes share one gateway.

## Not included

No upstream source is relicensed. Files under `vendor/` remain under the upstream
MIT license and retain their original copyright notices. Third-party notices for
the vendored channel pack are preserved at
`vendor/vendor/channel-pack/NOTICE.md`.

## Disclaimer

This port is not affiliated with, endorsed by, or supported by the upstream
author. Free third-party model channels are operated by the upstream project and
their availability, quotas, and terms are outside the control of this port. See
the upstream repository for the current terms of use.
