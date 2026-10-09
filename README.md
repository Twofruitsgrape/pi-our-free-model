# pi-our-free-model

Free frontier models for the [pi coding agent](https://github.com/earendil-works/pi) —
no login, no sign-up, no API key. A self-contained local gateway provides models
such as **GLM-5.3**, **Kimi K3**, **DeepSeek V4.1 Flash**, **Nemotron 3.5** and
many more, exposed to pi as an ordinary OpenAI-compatible provider.

> **This is a port.** The original project is
> [Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model),
> a plugin for DeepSeek Harness (DSH). All credit for the model channels, the
> catalog and the gateway belongs to its author. This package adapts the
> upstream **standalone** service to pi's plugin API. See [NOTICE.md](./NOTICE.md).

## Highlights

- **Zero configuration** — install, then pick a model. No DSH, no Cordis, no DSH
  profile, no DSH credentials, no account.
- **Independent of DeepSeek Harness** — the gateway is a plain local process with
  its own data directory (`~/.our-free-model`). It works on a machine where DSH
  was never installed.
- **Tools and streaming** — tool calling and SSE streaming are verified working,
  which is what a coding agent needs.
- **Live model discovery** — the model list comes from the gateway, enriched with
  each model's real context window, output limit, reasoning and vision support.
- **Runs out-of-process** — so `pi -p "..."` exits cleanly, and multiple pi
  sessions share one gateway.

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
pi --model our-free-model/stealth/glyph-cluster "hello"
```

## Usage

```bash
# Interactive, then choose a model with /model
pi

# One-shot with an explicit free model
pi --model our-free-model/inclusionai/ling-3.1-flash "explain this repo"

# Status: gateway URL, data dir, and the current model list
/free-models
```

Model ids are used exactly as the gateway reports them, e.g.
`stealth/glyph-cluster`, `mimo-v2.6-flash-free`, `openrouter/free`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PI_OUR_FREE_MODEL_HOME` | Data directory for the gateway (settings, catalog, stats, API key) | `~/.our-free-model` |

The gateway binds `127.0.0.1` only. Its API key is generated locally on first run
and stored in `<data dir>/settings.json` as `forwardKey`.

## How it works

```
pi process
  └── extensions/index.js        (this package)
        ├── spawns / adopts ─────► our-free-model gateway  (detached, 127.0.0.1)
        │                            └── vendor/packages/standalone/
        ├── GET /v1/models ──────► live model list
        └── pi.registerProvider("our-free-model", { api: "openai-completions", ... })
```

Two compatibility flags are required by this gateway and are set automatically:

- `supportsDeveloperRole: false` — it rejects OpenAI's `developer` role
- `maxTokensField: "max_tokens"` — it expects `max_tokens`, not `max_completion_tokens`

## Notes and limitations

- **Free channels are best-effort.** They are operated by the upstream project
  and their availability, rate limits and model rosters change without notice.
  Some models may be temporarily overloaded or retired. Treat this as a
  supplement to a paid provider, not a replacement.
- **The gateway is shared and stays running** after pi exits, so the next start
  is instant. To stop it, end the `node` process whose pid is in
  `<data dir>/service.lock`, or remove that file after stopping the process.
- **A stale lock is handled.** If a previous gateway was killed, the extension
  detects the dead owner, clears the lock and retries once.
- This port is not affiliated with or endorsed by the upstream author.

## License

MIT, matching upstream. Upstream copyright © 2026 Ebony-Vinyl. Vendored files
retain their original notices — see [LICENSE](./LICENSE) and [NOTICE.md](./NOTICE.md).
