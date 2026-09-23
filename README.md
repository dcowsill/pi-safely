# pi-auto-mode

A pi package that re-implements the core of Claude Code's auto mode for pi.

This is a fork of [`r4vi/pi-auto-mode`](https://github.com/r4vi/pi-auto-mode),
with the original two-stage generative classifier replaced by TypeSafe Jev
System One. The design is also modeled after
[`lghupan/cc-automode`](https://github.com/lghupan/cc-automode).

Features:

- read-only tool allowlist fast path
- deterministic hard-deny checks for obviously unsafe actions
- TypeSafe Jev System One classifier on every non-allowlisted tool call
- consecutive/total denial tracking
- auto-mode execution guidance injected into pi's system prompt
- on-demand denial history via `/auto-mode history`
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
   - auto-mode self-modification
3. everything else is sent to TypeSafe Jev in one System One request:
   - each configured deny rule becomes an independent Noul (yes/no probability)
   - deterministic code blocks when any rule reaches `jevBlockThreshold`
   - the denial reason names the strongest matching rule and its probability
4. if a denial happens in interactive mode, pi asks you whether to:
   - block
   - allow once
   - disable auto mode and allow

## Install

### From Forgejo

You do not need to clone the repo first.

```bash
pi install https://git.armless.xyz/dan/pi-auto-mode.git
```

You can also pin a ref:

```bash
pi install https://git.armless.xyz/dan/pi-auto-mode.git@v0.2.1
# or a tag / commit
pi install https://git.armless.xyz/dan/pi-auto-mode.git@<tag-or-commit>
```

### As a local package

From the directory containing this package:

```bash
pi install ./pi-auto-mode
```

### For one-off testing

```bash
pi -e ./pi-auto-mode/extensions/auto-mode.ts
```

## Usage

Once loaded, auto mode is enabled by default.

Commands:

```text
/auto-mode status
/auto-mode history
/auto-mode on
/auto-mode off
/auto-mode toggle
/auto-mode reset
/auto-mode reload
/auto-mode model
/auto-mode model jev-1.13.0
```

### TypeSafe credential

The extension registers an auth-only `typesafe` provider with Pi. It has no
generative models and does not appear in the model picker. Store the dedicated
Jev key through Pi's normal credential UI:

```text
/login
```

Choose **TypeSafe AI**, then enter the key. Pi stores it under `typesafe` in
`~/.pi/agent/auth.json`, with the same locking and `0600` permissions used for
other provider credentials. The extension retrieves it through Pi's model
registry; it does not read `auth.json` directly and has no gopass dependency.

## UI additions

- footer status for auto mode state
- recent denial history available on demand with `/auto-mode history`
- interactive override prompt when a denial happens

## Configuration

### Claude project allowlist interoperability

pi-auto-mode merges Claude Code tool allowlists from two places into its own fast-path allowlist:

Project-local files:

- `.claude/settings.user.json`
- `.claude/settings.json`

Global user files:

- `~/.claude/settings.user.json`
- `~/.claude/settings.json`

Supported fields:

- `permissions.allow`
- `permissions.allowedTools`
- `allow`
- `allowedTools`

Examples recognized:

```json
{
  "permissions": {
    "allow": ["Bash(*)", "Read(*)", "Edit(src/**)"]
  }
}
```

Those entries are normalized to tool names for pi's allowlist fast path, so `Bash(*)` becomes `bash`, `Read(*)` becomes `read`, etc.

It does not walk parent directories. It only reads the current project directory plus the global `~/.claude` directory.

You can inspect the merged result with:

```text
/auto-mode status
```

Create either of these in the target project:

- `.pi/auto-mode.json`
- `auto-mode.json`

Start from [`auto-mode.example.json`](./auto-mode.example.json).

Example:

```json
{
  "enabled": true,
  "failOpen": true,
  "maxConsecutiveDenials": 3,
  "maxTotalDenials": 20,
  "maxTranscriptLines": 60,
  "jevModel": "jev-1.13.0",
  "jevBaseUrl": "https://api.typesafe.ai",
  "jevBlockThreshold": 0.7,
  "jevTimeoutMs": 10000,
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

- `jevModel` is sent directly to TypeSafe's `/v1/systemone` endpoint.
- `jevBlockThreshold` is inclusive: a deny-rule probability equal to the
  threshold blocks.
- `failOpen` controls missing credentials, timeouts, HTTP errors, and malformed
  Jev responses. It remains `true` by default.
- The request contains the working directory, recent user/assistant text,
  assistant tool calls (never tool results), the proposed action, environment
  description, allow exceptions, and the deny-rule questions.
- Run `/auto-mode reload` after editing configuration outside Pi.

## Files

- `package.json` — pi package manifest
- `extensions/auto-mode.ts` — the extension
- `src/jev-classifier.ts` — System One request, validation, and deterministic routing
- `tests/jev-classifier.test.ts` — offline wire-format and routing tests
- `auto-mode.example.json` — starter config

## Known gaps vs official Claude Code auto mode

This package mirrors the open-source reference architecture, not Anthropic's private implementation.

Current differences:

- no server-side transcript prompt-injection probe
- no natural-language classifier explanation; reasons are derived from matched policy rules
- policy is project-config based rather than Claude hook config based

## Development

This package is intentionally dependency-free beyond Pi's extension runtime and
Node's built-in `fetch`. Run the offline classifier tests with:

```bash
npm test
```
