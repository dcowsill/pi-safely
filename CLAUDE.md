# CLAUDE.md

pi-safely is a pi coding-agent extension that implements Claude Code-style auto mode,
gating tool calls through a System One decision model (Cloudflare Clef via OpenRouter by
default, or TypeSafe Jev).

This file is the working rationale for the project. It exists so any agent (Claude Code,
pi itself, or a delegate) working in this repo understands **why** things are the way
they are and what conventions to follow.

## Lineage

pi-safely is a formal, independent fork of
[`r4vi/pi-auto-mode`](https://github.com/r4vi/pi-auto-mode) (MIT; original copyright is
retained in `LICENSE`). It was renamed and severed from upstream on 2026-10-06: there is
no `upstream` remote and the GitHub repo is not a GitHub fork. Do not try to track or
merge upstream changes; port anything useful by hand.

Git history before the rename is pi-auto-mode's history and is kept for attribution.

## What pi-safely is

A pi extension (loaded as a pi package, entry at `extensions/safely.ts`) that gates
every non-allowlisted tool call through one System One request before execution.
Each configured deny rule is represented by an independent Noul question. Pure code
validates every answer and blocks when any probability reaches `blockThreshold`.
Tool results are stripped from the transcript. Denials return as tool results and the
agent continues (deny-and-continue); 3 consecutive or 20 total denials per session
pause/escalate.

It is modeled after [`lghupan/cc-automode`](https://github.com/lghupan/cc-automode).

## Classifier backends

`src/system-one-classifier.ts` holds a `SYSTEM_ONE_PROVIDERS` table. Every provider
speaks the same `POST {baseUrl}/v1/systemone` wire format
(`{model, state, questions}` → `{model, answers: {name: {type: "noul", noul}}, usage}`),
so a provider is just: label, base URL, default model, extra headers. The Pi credential
is looked up via `ctx.modelRegistry.getApiKeyForProvider(config.provider)`, so the
provider key must equal the Pi provider name.

- `openrouter` (default) — Pi's built-in OpenRouter credential; default model
  `cloudflare/clef`. OpenRouter also serves `cloudflare/clef-flash` and TypeSafe Jev
  (`typesafe/jev-1.13`, `~typesafe/jev-latest`). Response `usage.cost` is captured.
- `typesafe` — auth-only Pi provider registered by the extension, key stored via
  `/login`; default model `jev-1.13.0`.

Adding another System One host (e.g. Cloudflare Workers AI direct, a local Ollama/vLLM
Clef) means adding a table entry; non-Bearer auth or a different path would need the
request builder to become per-provider.

Live-verified 2026-10-06: `cloudflare/clef` and `cloudflare/clef-flash` on OpenRouter
return the exact TypeSafe answer shape. In a smoke run, benign actions scored ≤0.35 and
`git push --force origin main` scored 0.74 against the 0.7 default threshold — the
margin is thin, so treat threshold tuning per model as open work.

## Config

- Precedence: project-local → global (`~/.pi/safely.json`) → built-in `DEFAULT_CONFIG`.
  Within each scope `safely.json` beats the legacy `auto-mode.json`, which is read only
  so pi-auto-mode configs keep working.
- `saveConfig` writes to the pi-safely-named file in the scope of the config in effect
  (`getConfigWritePath`), migrating legacy files on first write without touching them.
- `mergeConfig` accepts legacy `jev*` fields and infers `provider: "typesafe"` when
  they are present without an explicit `provider`.

> **Caveat (cross-session clobber race):** the global file is a shared mutable resource,
> but every session holds its own in-memory copy loaded once at `session_start`. The
> `on` / `off` / `toggle` / `provider` / `model` commands (and the `disable-and-allow`
> override path) all call `saveConfig`, which writes that session's **entire** in-memory
> config back over the file — so a session that started before an out-of-band file edit
> will clobber it with stale values. `off` is especially nasty because it also flips
> `enabled: false` globally. Practical guidance: after any file edit, run
> `/safely reload` in active sessions. A possible fix is narrowing the toggle paths to
> persist only the changed field — open enhancement, not yet implemented.

## Remotes

- `origin` → `github.com/dcowsill/pi-safely` (private for now; will be made public later)

## Compatibility note

The package targets the current `@earendil-works/pi-coding-agent` scope. Its peer
dependency is optional because Pi supplies the coding-agent runtime to extensions; this
prevents a git package install from downloading a redundant nested copy of Pi.

## Working in this repo

- **Testing changes locally:** `pi --extension ~/projects/pi-safely/extensions/safely.ts -p "<prompt>"`.
  Make sure no other auto-mode extension (e.g. `npm:pi-auto-mode` in
  `~/.pi/agent/settings.json`) is also loaded, or you are testing two gates at once.
- **Verifying gating:** first confirm pi-safely is actually enabled (`/safely status`,
  or `enabled: true` in the resolved config) — a passing action is meaningless if the
  gate is off. Then probe with benign bash (`echo …`): `bash` is **not** in the default
  allowlist, so it genuinely hits the classifier. For a classifier block, ask for
  `git push --force origin main` in a scratch repo. For the hard-deny path,
  `echo x >> ~/.ssh/authorized_keys` triggers the SSH-key-injection regex regardless of
  model; use the bash redirect form, since an agent may refuse a `write` to that path on
  its own judgement, which exercises nothing. In `-p` mode classifier reasons are
  visible in the session JSONL (`safely-state` entries, `lastReason`).
- **Offline tests:** `npm test` (Node's built-in runner, no dependencies).
- **Config for testing:** a scratch dir with `.pi/safely.json` keeps tests away from your
  global config. `safely.example.json` documents all fields. Mind the clobber race above.
