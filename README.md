# pi-safely

A pi package that re-implements the core of Claude Code's auto mode for pi, gating
every non-allowlisted tool call through a **System One decision model** — a model that
returns calibrated yes/no probabilities instead of generated text.

Supported classifier backends (same `POST /v1/systemone` wire format):

| Provider | Default base URL | Example models | Credential |
|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api` | `cloudflare/clef` (default), `cloudflare/clef-flash`, `typesafe/jev-1.13`, `~typesafe/jev-latest` | Pi's built-in OpenRouter key |
| `typesafe` | `https://api.typesafe.ai` | `jev-1.13.0`, `jev-latest`, `jev-preview` | Dedicated TypeSafe key via `/login` |

pi-safely began as a fork of [`r4vi/pi-auto-mode`](https://github.com/r4vi/pi-auto-mode)
and is now maintained independently. The design is also modeled after
[`lghupan/cc-automode`](https://github.com/lghupan/cc-automode).

Features:

- read-only tool allowlist fast path
- deterministic hard-deny checks for obviously unsafe actions
- System One classifier (Cloudflare Clef or TypeSafe Jev) on every non-allowlisted tool call
- consecutive/total denial tracking
- auto-mode execution guidance injected into pi's system prompt
- on-demand denial history via `/safely history`
- user override prompt on denials

## What it does

When enabled, the extension intercepts tool calls in pi:

1. `read`, `grep`, `find`, and `ls` are allowed immediately by default.
   - this allowlist is also extended from local Claude Code project settings in:
     - `.claude/settings.user.json`
     - `.claude/settings.json`
   - the extension reads `permissions.allow`, `permissions.allowedTools`, `allow`, and `allowedTools` arrays when present
2. obvious hard-deny patterns are blocked immediately:
   - shell profile writes
   - cron creation
   - TLS verification weakening
   - destructive deletes outside the workspace
   - SSH key injection
   - pi-safely self-modification
3. everything else is sent to the configured System One model in one request:
   - each configured deny rule becomes an independent Noul (yes/no probability)
   - deterministic code blocks when any rule reaches `blockThreshold`
   - the denial reason names the model, the strongest matching rule, and its probability
4. if a denial happens in interactive mode, pi asks you whether to:
   - block
   - allow once
   - disable pi-safely and allow

## Install

```bash
pi install https://github.com/dcowsill/pi-safely.git
# or pin a ref
pi install https://github.com/dcowsill/pi-safely.git@v0.3.0
```

From a local checkout:

```bash
pi install ./pi-safely
```

For one-off testing:

```bash
pi -e ./pi-safely/extensions/safely.ts
```

> **Migrating from pi-auto-mode:** uninstall `pi-auto-mode` first. Running both
> extensions double-gates every tool call. pi-safely reads your existing
> `auto-mode.json` as a fallback (see [Configuration](#configuration)).

## Usage

Once loaded, pi-safely is enabled by default.

```text
/safely status
/safely history
/safely on
/safely off
/safely toggle
/safely reset
/safely reload
/safely provider                  # show provider
/safely provider openrouter       # switch; resets model + baseUrl to that provider's defaults
/safely provider typesafe
/safely model                     # show model
/safely model cloudflare/clef-flash
```

### Credentials

- **OpenRouter** (default): uses the key Pi already has for its built-in `openrouter`
  provider. If you have not set one, run `/login` and choose OpenRouter. If you use
  OpenRouter workspace guardrails, the provider behind your chosen model (Cloudflare for
  Clef, TypeSafe for Jev) must be allowed, or requests fail with HTTP 404.
- **TypeSafe**: the extension registers an auth-only `typesafe` provider with no
  generative models. Run `/login`, choose **TypeSafe AI**, and enter the key. Pi stores
  it under `typesafe` in `~/.pi/agent/auth.json` with `0600` permissions.

The extension retrieves keys through Pi's model registry; it never reads `auth.json`
directly.

## UI additions

- footer status for pi-safely state
- recent denial history available on demand with `/safely history`
- interactive override prompt when a denial happens

## Configuration

Config files, first match wins:

1. `<cwd>/.pi/safely.json`
2. `<cwd>/safely.json`
3. `<cwd>/.pi/auto-mode.json` *(legacy pi-auto-mode name)*
4. `<cwd>/auto-mode.json` *(legacy)*
5. `~/.pi/safely.json` (global)
6. `~/.pi/auto-mode.json` *(legacy global)*
7. built-in defaults

Commands that change config (`on`, `off`, `toggle`, `provider`, `model`, and the
"disable + allow" override) write the whole in-memory config to the **pi-safely-named**
file in the same scope. Saving over a legacy `auto-mode.json` therefore creates
`safely.json` next to it, which takes precedence from then on; the legacy file is left
untouched.

Start from [`safely.example.json`](./safely.example.json):

```json
{
  "enabled": true,
  "failOpen": true,
  "maxConsecutiveDenials": 3,
  "maxTotalDenials": 20,
  "maxTranscriptLines": 60,
  "provider": "openrouter",
  "model": "cloudflare/clef",
  "baseUrl": "https://openrouter.ai/api",
  "blockThreshold": 0.7,
  "timeoutMs": 10000,
  "allowlistedTools": ["read", "grep", "find", "ls"],
  "environment": [
    "**Trusted repo**: this repository and its configured remotes",
    "**Trusted internal domains**: api.mycorp.internal, registry.mycorp.internal"
  ],
  "allowRules": [],
  "denyRules": []
}
```

### Notes

- `provider` selects the endpoint defaults and the Pi credential. `model` and `baseUrl`
  default per provider when omitted; set them explicitly only to override.
- Legacy pi-auto-mode fields `jevModel`, `jevBaseUrl`, `jevBlockThreshold`, and
  `jevTimeoutMs` are still read. A config with `jevModel`/`jevBaseUrl` and no
  `provider` is treated as `provider: "typesafe"`.
- `blockThreshold` is inclusive: a deny-rule probability equal to the threshold blocks.
  Calibration differs between models; revisit the threshold when switching models.
- `failOpen` controls missing credentials, timeouts, HTTP errors, and malformed
  responses. It remains `true` by default.
- The request contains the working directory, recent user/assistant text,
  assistant tool calls (never tool results), the proposed action, environment
  description, allow exceptions, and the deny-rule questions.
- Run `/safely reload` after editing configuration outside Pi.

### Claude project allowlist interoperability

pi-safely merges Claude Code tool allowlists into its fast-path allowlist from
`.claude/settings.user.json` and `.claude/settings.json`, both project-local and in
`~/.claude`. Supported fields: `permissions.allow`, `permissions.allowedTools`, `allow`,
`allowedTools`.

```json
{
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Edit(src/**)"]
  }
}
```

Entries are normalized to tool names, so `Bash(*)` becomes `bash`, `Read(*)` becomes
`read`, etc. Parent directories are not walked. Inspect the merged result with
`/safely status`.

## Files

- `package.json` — pi package manifest
- `extensions/safely.ts` — the extension
- `src/system-one-classifier.ts` — provider table, System One request, validation, and deterministic routing
- `tests/system-one-classifier.test.ts` — offline wire-format, routing, and config tests
- `safely.example.json` — starter config

## Known gaps vs official Claude Code auto mode

This package mirrors the open-source reference architecture, not Anthropic's private implementation.

- no server-side transcript prompt-injection probe
- no natural-language classifier explanation; reasons are derived from matched policy rules
- policy is project-config based rather than Claude hook config based

## Development

This package is intentionally dependency-free beyond Pi's extension runtime and Node's
built-in `fetch`. Run the offline tests with:

```bash
npm test
```
