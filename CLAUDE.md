# CLAUDE.md

This is a fork of [`r4vi/pi-auto-mode`](https://github.com/r4vi/pi-auto-mode) — a pi
coding-agent extension that re-implements Claude Code's "auto mode" two-stage
tool-call permission classifier for pi.

This file is the working rationale for our local fork. It exists so any agent (Claude
Code, pi itself, or a delegate) working in this repo understands **why** this fork exists
and what conventions to follow.

## What pi-auto-mode is

A pi extension (loaded as a pi package, entry at `extensions/auto-mode.ts`) that gates
every non-allowlisted tool call through a two-stage LLM classifier before execution:

- **Stage 1** — a cheap single-token `YES`/`NO` filter (`maxTokens: 5`), biased toward
  blocking ("err toward YES if uncertain"). High recall, ~8.5% false-positive rate.
- **Stage 2** — chain-of-thought reasoning (`maxTokens: 700`, `reasoningEffort` from
  config), runs **only** if Stage 1 flags. Returns JSON `{shouldBlock, reason, thinking}`.
  Because the system prompt + transcript + action are byte-identical to Stage 1, this is
  effectively a prompt-cache hit.

Both stages share one hardcoded system prompt with three configurable slots
(`<ENVIRONMENT>`, `<DENY_RULES>`, `<ALLOW_RULES>`). Tool *results* are stripped from the
transcript (reasoning-blind — the structural prompt-injection defense). Denials return as
tool results and the agent continues (deny-and-continue); 3 consecutive or 20 total
denials per session pause/escalate.

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

### 2. Configurable classifier prompts (planned — not yet implemented)

The three prompt artifacts — the shared system prompt's fixed prose, the Stage 1 user
message, and the Stage 2 user message + JSON schema — are **hardcoded constants** in
`extensions/auto-mode.ts`:

- `CLASSIFIER_SYSTEM_PROMPT` (10 principles + framing; slots are configurable, prose is not)
- Stage 1 instruction: `"Should this action be blocked? Reply with only YES or NO. Err toward YES if uncertain."`
- Stage 2 instruction: the JSON schema `{"shouldBlock", "reason", "thinking"}` + instruction
- `AUTO_MODE_GUIDANCE` (the block injected into the *agent's* system prompt via `before_agent_start`)

Only the three slots (`environment`, `denyRules`, `allowRules`) and `reasoningEffort` /
`classifierModel` / `maxTranscriptLines` are user-configurable. The bias wording, the 10
principles, the token budgets, and the Stage 2 JSON shape are fixed.

**Goal:** add optional config fields (e.g. `systemPrompt`, `stage1Instruction`,
`stage2Instruction`, `agentGuidance`) that override the constants when present, falling
back to the hardcoded defaults otherwise. This lets us tune Stage-1 bias, swap the JSON
schema, or customize the principles per project without forking the prose.

> **Status:** implementation is deferred and will be done by a delegated agent. Do **not**
> start it unless explicitly asked — see "Working in this repo" below.

## Remotes

- `origin` → `github.com/dcowsill/pi-auto-mode` (our fork; push here)
- `upstream` → `github.com/r4vi/pi-auto-mode` (track and pull upstream changes)

Working branch: `dcowsill/main`. Keep commits focused; we want clean PRs back to upstream
where the changes are generally useful (the global-config patch is a good upstream PR
candidate; highly custom prompt tuning may stay fork-only).

## Compatibility note

The package's `peerDependencies` and source imports reference the **old** pi package scope
`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`. This is
**not** a bug and does **not** need fixing: pi's extension loader
(`dist/core/extensions/loader.js`) maintains an alias map that resolves both
`@mariozechner/*` and `@earendil-works/*` to the same bundled instances. So this extension
loads cleanly against current `@earendil-works/pi-coding-agent` with no patching. Do not
"fix" the imports to `@earendil-works/*` — that would break resolution against older pi
installs that only have the `@mariozechner` scope.

## Working in this repo

- **Testing changes locally:** run the fork directly without reinstalling the npm package —
  `pi --extension ~/Projects/pi-auto-mode/extensions/auto-mode.ts -p "<prompt>"`. This
  shadows the installed `npm:pi-auto-mode` for that run.
- **Verifying gating:** benign bash (`echo …`) should pass; an `~/.ssh/authorized_keys`
  write triggers a hard-deny regex and should be blocked.
- **Config for testing:** `~/.pi/auto-mode.json` (global) or `<cwd>/.pi/auto-mode.json`
  (project). The shipped `auto-mode.example.json` documents all fields.
- **Don't** start implementing configurable prompts (item 2 above) unless explicitly
  asked — that work is earmarked for a delegated agent.

## Reference

- Original design writeup: `~/auto-mode-classifier-plan.md` (analysis of Claude Code's
  auto mode + pi's extension surface).
- Upstream README: `README.md` in this repo.
