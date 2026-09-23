# CLAUDE.md

This is a fork of [`r4vi/pi-auto-mode`](https://github.com/r4vi/pi-auto-mode) — a pi
coding-agent extension that implements Claude Code-style auto mode with a TypeSafe
Jev System One tool-call policy classifier for pi.

This file is the working rationale for our local fork. It exists so any agent (Claude
Code, pi itself, or a delegate) working in this repo understands **why** this fork exists
and what conventions to follow.

## What pi-auto-mode is

A pi extension (loaded as a pi package, entry at `extensions/auto-mode.ts`) that gates
every non-allowlisted tool call through one Jev System One request before execution.
Each configured deny rule is represented by an independent Noul question. Pure code
validates every answer and blocks when any probability reaches `jevBlockThreshold`.
Tool results are stripped from the transcript. Denials return as tool results and the
agent continues (deny-and-continue); 3 consecutive or 20 total denials per session
pause/escalate.

The TypeSafe key is stored through Pi's native `/login` flow as the auth-only provider
`typesafe` in `~/.pi/agent/auth.json`. There is no gopass dependency and Jev is not
registered as a generative model.

It is modeled after [`lghupan/cc-automode`](https://github.com/lghupan/cc-automode).

## Why we forked

The upstream package is good and we run it in production, but it has two gaps we need to
close locally rather than wait on upstream:

### 1. Global config support (already patched on `dcowsill/main`)

Upstream `getConfigPath()` only reads **project-local** config (`<cwd>/.pi/auto-mode.json`
or `<cwd>/auto-mode.json`). There is no global path, so every project needs its own config
file to do anything other than ship defaults — and `/auto-mode model` writes back to the
project path it resolved.

We want auto-mode configured **once, globally** (a single `~/.pi/auto-mode.json`) with
per-project files as optional overrides. The patch adds a global fallback to
`getConfigPath()`:

- precedence: project-local → global (`~/.pi/auto-mode.json`) → built-in `DEFAULT_CONFIG`
- the global path is only consulted when no project-local file exists, so existing
  per-project behavior is unchanged

This matches how pi itself treats user/global vs project-local resources, and how pi's
`settings.json` (which registers `npm:pi-auto-mode` under `packages`) is global.

> **Caveat (cross-session clobber race):** the global file is a shared mutable resource,
> but every auto-mode session holds its own in-memory copy loaded once at
> `session_start`. The `on` / `off` / `toggle` / `model` commands (and the
> `disable-and-allow` override path) all call `saveConfig`, which writes that
> session's **entire** in-memory config back over the file — so a session that
> started before an out-of-band file edit will clobber it with stale values.
> `off` is especially nasty because it also flips `enabled: false` globally.
> Practical guidance: when sessions are running, prefer `/auto-mode model` or
> `/auto-mode reload` over hand-editing the file; after any file edit, run
> `/auto-mode reload` in active sessions to sync their in-memory copy. A possible
> fix is narrowing the toggle paths to persist only the `enabled` field (or not
> persist toggles at all) — open enhancement, not yet implemented.

### 2. Jev classifier backend

The upstream two-stage generative classifier has been removed. `src/jev-classifier.ts`
builds one Noul per deny rule, posts the request to `/v1/systemone`, validates the full
answer map, and derives a deterministic result. The active model, endpoint, threshold,
and timeout are configured with `jevModel`, `jevBaseUrl`, `jevBlockThreshold`, and
`jevTimeoutMs`.

## Remotes

- `forgejo` → `git.armless.xyz/dan/pi-auto-mode` (canonical public release repository)
- `origin` → `github.com/dcowsill/pi-auto-mode` (historical GitHub fork)
- `upstream` → `github.com/r4vi/pi-auto-mode` (track and pull upstream changes)

Publish the Forgejo repository from `main`. Keep commits focused so generally useful
changes can still be proposed upstream independently.

## Compatibility note

The published package targets the current `@earendil-works/pi-coding-agent` scope. Its
peer dependency is optional because Pi supplies the coding-agent runtime to extensions;
this prevents a git package install from downloading a redundant nested copy of Pi.

## Working in this repo

- **Testing changes locally:** run the fork directly without reinstalling the npm package —
  `pi --extension ~/Projects/pi-auto-mode/extensions/auto-mode.ts -p "<prompt>"`. This
  shadows the installed `npm:pi-auto-mode` for that run.
- **Verifying gating:** first confirm auto-mode is actually enabled (`enabled: true` in
  the resolved config, or `/auto-mode status`) — a passing action is meaningless if the
  gate is off, since disabled auto-mode lets everything through. Then probe with benign
  bash (`echo …`): `bash` is **not** in the default allowlist (only `read`/`grep`/`find`/
  `ls` are), so it genuinely hits the classifier when enabled. A passing `echo` with
  auto-mode on is real evidence the classifier ran and allowed it. For the hard-deny
  path, `echo x >> ~/.ssh/authorized_keys` triggers the SSH-key-injection regex
  regardless of model. Beware: an agent may refuse to *attempt* a `write` to
  `~/.ssh/authorized_keys` on its own judgement, which exercises nothing — use the bash
  redirect form so the hard-deny regex actually fires. The Jev path additionally requires
  a TypeSafe key installed through `/login`; run `npm test` for offline routing coverage.
- **Config for testing:** `~/.pi/auto-mode.json` (global) or `<cwd>/.pi/auto-mode.json`
  (project). The shipped `auto-mode.example.json` documents all fields. Mind the
  cross-session clobber race described under item 1 above — after hand-editing the file,
  run `/auto-mode reload` in any active session so its in-memory copy syncs and doesn't
  overwrite your edit on its next `saveConfig`.

## Reference

- Original design writeup: `~/auto-mode-classifier-plan.md` (analysis of Claude Code's
  auto mode + pi's extension surface).
- Upstream README: `README.md` in this repo.
