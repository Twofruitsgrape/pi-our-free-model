# pi-our-free-model

Free frontier models for the [pi coding agent](https://github.com/earendil-works/pi) —
no login, no sign-up, no API key. A self-contained local gateway provides models
such as **DeepSeek V4.1 Flash**, **Kimi K3**, **GLM-5.3**, **Nemotron 3.5** and
hundreds more, exposed to pi as an ordinary OpenAI-compatible provider.

> **This is a port.** The original project is
> [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model),
> a plugin for DeepSeek Harness (DSH). All credit for the model channels, the
> catalog and the gateway belongs to its author. See [NOTICE.md](./NOTICE.md).

## Highlights

- **Zero configuration** — install, then pick a model. No DSH, no Cordis, no DSH
  profile, no DSH credentials, no account.
- **Independent of DeepSeek Harness** — the gateway is a plain local process with
  its own data directory (`~/.our-free-model`). It works on a machine where DSH
  was never installed.
- **Pin-synced from upstream** — the gateway code is one reviewed commit of
  upstream, not a drifting fork. See [Updating](#updating).
- **Live model discovery** — the model list comes from the gateway, enriched with
  each model's real context window, output limit, reasoning and vision support.
- **Runs out-of-process** — so `pi -p "..."` exits cleanly, and multiple pi
  sessions share one gateway.
- **A local console** — the gateway serves its own management UI, reachable with
  `/free-models open` (model browser, usage dashboard, channel accounts, settings).

## Requirements

- pi coding agent **1.0.2** or later
- Node.js **22.19+** or **24+** (matching the pi runtime)
- Windows, macOS, or Linux

## Install

```bash
pi install npm:pi-our-free-model
```

Or from a local checkout:

```bash
pi install ./pi-our-free-model
```

Then list the models:

```bash
pi --list-models our-free-model
```

Pick one interactively with `/model`, or for a single run:

```bash
pi --model our-free-model/inclusionai/ling-3.1-flash "explain this repo"
```

## Usage

```bash
# Interactive, then choose a model with /model
pi

# One-shot with an explicit free model
pi --model our-free-model/codearts/deepseek-v4-flash "explain this repo"

# Status: gateway URL, data dir, and the current model list
/free-models
```

`/free-models` takes a subcommand:

| Command | What it does |
|---|---|
| `status` (default) | Model count, gateway URL, gateway source and pin |
| `open` | Open the gateway's management console in a browser |
| `refresh` | Re-read the gateway's model list and re-register the provider |
| `update` | Fetch the newest upstream commit into the runtime cache |
| `runtimes` | List the cached gateway revisions and the web asset count |

Model ids are used exactly as the gateway reports them, e.g.
`stealth/glyph-cluster`, `mimo-v2.6-flash-free`, `codearts/glm-5.3-flash`,
`openrouter/free`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PI_OUR_FREE_MODEL_HOME` | Data directory for the gateway (settings, catalog, stats, credentials) | `~/.our-free-model` |
| `PI_OUR_FREE_MODEL_CACHE` | Directory holding the staged gateway revisions | `~/.our-free-model/runtimes` |

Both are also exposed as `PI_OUR_FREE_MODEL_HOME` / `PI_OUR_FREE_MODEL_CACHE`
to the gateway process.

The gateway binds `127.0.0.1` only. Its API key is generated locally on first run
and stored in `<data dir>/settings.json` as `forwardKey`.

## How it works

```
pi process
  └── extensions/index.js            (this package)
        ├── resolveRuntime()         pin → cached snapshot, else the bundled tree
        ├── ensureService()          spawn / adopt the gateway (detached, 127.0.0.1)
        ├── GET /v1/models ─────────► live model list
        ├── read catalog.json ──────► context window, max output, reasoning, vision
        └── pi.registerProvider("our-free-model", ...)
```

The gateway code itself is a pinned snapshot of upstream's standalone service,
staged under `~/.our-free-model/runtimes/snapshots/<revision>/`. The npm package
ships that snapshot too, under `bundled/`, so the first launch works with no
network at all.

Two compatibility flags are required by this gateway and are set automatically:

- `supportsDeveloperRole: false` — it rejects OpenAI's `developer` role
- `maxTokensField: "max_tokens"` — it expects `max_tokens`, not `max_completion_tokens`

## Updating

The gateway is pinned to one upstream revision. `bundled/manifest.json` is the
only file that records it, so moving forward is a single-artifact change:

```bash
# from a clone of this repository
node scripts/bump-pin.mjs --latest      # or: <specific 40-character sha>
node scripts/verify-bundled.mjs        # bytes, closure, and a real gateway boot
git add bundled && git commit -m "pin: upstream <revision>"
pi install npm:pi-our-free-model       # refresh the installed package
```

`verify-bundled.mjs` is not a lint pass. It starts the pinned gateway on an
ephemeral port in a throwaway data directory, waits for `/health`, lists
`/v1/models`, and asks the management console for a real bundle — then shuts it
down. A pin that cannot boot does not get committed.

Without touching the package at all, `/free-models update` fetches the newest
upstream commit into the runtime cache and verifies it resolves as a closed
import graph. It does not change the pin, and it does not affect the gateway a
running session is using; a restart picks it up.

### Reviewing a pin

`bump-pin.mjs` clones upstream with `--filter=blob:none`, checks out the target
revision, and leaves it in `.upstream/` so the commit can be read before the
manifest is rewritten:

```bash
node scripts/bump-pin.mjs <revision>
git -C .upstream log -1 --stat      # what is actually in this revision
node scripts/verify-bundled.mjs    # does it boot
```

`bump-pin.mjs` materializes the tree **before** writing the manifest, so a bad
network or a wrong revision fails before the pin claims to have moved.

### What a pin snapshot contains

The upstream tree filtered to the gateway's closed import closure, plus its web
assets — 57 modules, about 16 MiB. Deliberately excluded: `vendor/channel-pack/pack.js`
(2.9 MiB, read only by upstream's *build* scripts), the React/Vite sources in
`packages/standalone/frontend`, and the entire DSH plugin half (`index.js`,
`client.js`, `adapter/`, `feed/`, `scripts/`, `docs/`, `.github/`).

## Notes and limitations

- **Free channels are best-effort.** They are operated by the upstream project
  and their availability, rate limits and model rosters change without notice.
  Some models may be temporarily overloaded or retired. Treat this as a
  supplement to a paid provider, not a replacement — and note that upstream
  states some channels may record prompts.
- **The gateway is shared and stays running** after pi exits, so the next start
  is instant. To stop it, end the `node` process whose pid is in
  `<data dir>/service.lock`, or remove that file after stopping the process.
- **A stale lock is handled.** If a previous gateway was killed, the extension
  detects the dead owner, clears the lock and retries once.
- **The first model list is short and then fills out.** The free lane answers
  immediately; the account channels report in behind it. The extension
  re-registers the provider once they are in.
- This port is not affiliated with or endorsed by the upstream author.

## License

MIT, matching upstream. Upstream copyright © 2026 Ebony-Vinyl. Bundled files
retain their original notices — see [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
