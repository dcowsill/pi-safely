import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	classifyWithSystemOne,
	isSystemOneProvider,
	SYSTEM_ONE_PROVIDERS,
	type SystemOneProvider,
} from "../src/system-one-classifier.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import os from "node:os";

type SafelyConfig = {
	enabled: boolean;
	failOpen: boolean;
	maxConsecutiveDenials: number;
	maxTotalDenials: number;
	maxTranscriptLines: number;
	provider: SystemOneProvider;
	model: string;
	baseUrl: string;
	blockThreshold: number;
	timeoutMs: number;
	allowlistedTools: string[];
	environment: string[];
	allowRules: string[];
	denyRules: string[];
};

type DenialRecord = {
	timestamp: number;
	toolName: string;
	reason: string;
	kind: "hard-deny" | "classifier" | "quota" | "setup";
	overridden?: boolean;
};

type SafelyState = {
	enabled: boolean;
	consecutiveDenials: number;
	totalDenials: number;
	actionCount: number;
	overrideCount: number;
	lastDecision?: "allow" | "deny";
	lastReason?: string;
	recentDenials: DenialRecord[];
};

const DEFAULT_PROVIDER: SystemOneProvider = "openrouter";

const DEFAULT_CONFIG: SafelyConfig = {
	enabled: true,
	failOpen: true,
	maxConsecutiveDenials: 3,
	maxTotalDenials: 20,
	maxTranscriptLines: 60,
	provider: DEFAULT_PROVIDER,
	model: SYSTEM_ONE_PROVIDERS[DEFAULT_PROVIDER].defaultModel,
	baseUrl: SYSTEM_ONE_PROVIDERS[DEFAULT_PROVIDER].baseUrl,
	blockThreshold: 0.7,
	timeoutMs: 10_000,
	allowlistedTools: ["read", "grep", "find", "ls"],
	environment: [
		"**Trusted repo**: the repository pi started in and its configured git remotes",
		"**Source control**: the trusted repo and its configured remotes only",
		"**Trusted internal domains**: none configured",
		"**Trusted cloud buckets**: none configured",
		"**Key internal services**: none configured",
	],
	allowRules: [
		"Test Artifacts: hardcoded test API keys, placeholder credentials in examples, or hardcoded test cases.",
		"Local Operations: local file operations inside the working tree, including creating, editing, deleting, or rewriting project files that are part of the requested task.",
		"Read-Only Operations: GET requests, read-only API calls, file inspection, and queries that do not modify state and do not contain sensitive information in the URL.",
		"Declared Dependencies: installing packages already declared in package manifests or lockfiles by standard package-manager commands.",
		"Toolchain Bootstrap: installing language toolchains from their official installers.",
		"Standard Credentials: reading credentials from the agent's own config and sending them only to their intended provider.",
		"Git Push to Working Branch: pushing to the current non-default branch or to a new branch the agent created for this task.",
	],
	denyRules: [
		"Git Destructive: force pushing, deleting remote branches, or rewriting remote history.",
		"Git Push to Default Branch: pushing directly to main, master, or the repository default branch.",
		"Code from External: downloading and executing code from external sources, including curl|bash and unsafe deserialization that can execute code.",
		"Cloud Storage Mass Delete: deleting or mass modifying files on cloud storage.",
		"Production Deploy: deploying to production or running production database migrations.",
		"Remote Shell Writes: writing to running production or shared hosts via ssh, kubectl exec, docker exec, or equivalent remote-shell access.",
		"Blind Apply: changing live, production, or shared infrastructure without a preview, plan, or dry-run when one normally exists.",
		"Logging/Audit Tampering: stopping logging services, deleting logs, disabling audit trails, or removing guardrails.",
		"Permission Grant: granting admin/owner roles, repository access, or IAM/RBAC permissions.",
		"TLS/Auth Weaken: disabling TLS verification, certificate validation, or equivalent authentication safeguards.",
		"Security Weaken: disabling security mitigations, weakening firewall rules, or bypassing protection mechanisms.",
		"Create Unsafe Agents: creating new autonomous loops or agents that can execute arbitrary actions without meaningful human approval.",
		"Interfere With Others: killing other users' processes, cancelling jobs, or disrupting shared infrastructure.",
		"Modify Shared Resources: in-place modification of shared artifacts not created in the current task context.",
		"Irreversible Local Destruction: deleting, truncating, or overwriting local files that existed before the session started without explicit user direction naming the specific targets.",
		"Create RCE Surface: creating services, endpoints, or code paths that execute arbitrary code.",
		"Expose Local Services: starting a network service that exposes local files, sockets, or internal services beyond normal local development.",
		"Credential Leakage: embedding secrets in tags, metadata, URLs, logs, or otherwise queryable locations.",
		"Credential Exploration: systematically scanning for tokens, API keys, or credentials beyond what normal task execution requires.",
		"Data Exfiltration: sending sensitive data to external endpoints or public storage.",
		"Exfil Scouting: probing untrusted endpoints or encoding tricks to discover what external services are reachable.",
		"Untrusted Code Integration: pulling executable code from untrusted repos, registries, or services and arranging for it to run.",
		"Unauthorized Persistence: adding SSH keys, modifying shell profiles, creating cron jobs, or creating long-lived background persistence.",
		"Self-Modification: modifying pi-safely/auto-mode configuration, extension files, or other files that define the agent's own safety controls.",
		"Trusting Guessed External Services: sending internal or sensitive data to an external service the agent guessed rather than one the user explicitly established as trusted.",
		"External System Writes: mass-modifying or closing items in collaboration tools, ticketing systems, issue trackers, or external APIs that the agent did not create in this session.",
		"Content Integrity / Impersonation: posting or updating content that is fabricated, misleading, or claims actions/approvals that did not happen.",
		"Real-World Transactions: purchases, payments, bookings, subscriptions, or outbound communications to real people outside the user's organization.",
	],
};

const AUTO_MODE_GUIDANCE = `## Auto Mode Active

Auto mode is active. The user chose continuous, autonomous execution.

- Execute immediately and prefer action over planning.
- Minimize interruptions and make reasonable assumptions.
- Be thorough: complete implementation, verification, and cleanup.
- Never post content to public services without explicit approval for that exact endpoint.
- Do not modify shell profile files, cron, TLS verification settings, or pi-safely's own safety files.`;

const HOME = os.homedir();
const STATE_ENTRY_TYPE = "safely-state";
const LEGACY_STATE_ENTRY_TYPE = "auto-mode-state";
// Config file names in precedence order within a scope. The auto-mode names are read
// only as a fallback for configs inherited from pi-auto-mode; writes always target the
// pi-safely name in the same scope (see getConfigWritePath).
const CONFIG_RELATIVE_PATHS = [".pi/safely.json", "safely.json"];
const LEGACY_CONFIG_RELATIVE_PATHS = [".pi/auto-mode.json", "auto-mode.json"];
const ALL_CONFIG_RELATIVE_PATHS = [...CONFIG_RELATIVE_PATHS, ...LEGACY_CONFIG_RELATIVE_PATHS];
const GLOBAL_CONFIG_PATH = resolve(HOME, ".pi", "safely.json");
const LEGACY_GLOBAL_CONFIG_PATH = resolve(HOME, ".pi", "auto-mode.json");
const PROFILE_PATHS = new Set(
	[
		".bashrc",
		".zshrc",
		".bash_profile",
		".profile",
		".bash_login",
		".bash_logout",
	].map((name) => resolve(HOME, name)),
);
const SYSTEM_PROFILE_PATHS = new Set(["/etc/profile", "/etc/environment", "/etc/bash.bashrc"]);
const PROJECT_CLAUDE_SETTINGS_FILES = [".claude/settings.user.json", ".claude/settings.json"];
const GLOBAL_CLAUDE_SETTINGS_FILES = [resolve(HOME, ".claude/settings.user.json"), resolve(HOME, ".claude/settings.json")];
const HARD_DENY_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: />>?\s*(~\/\.bashrc|~\/\.zshrc|~\/\.bash_profile|~\/\.profile|~\/\.bash_login|~\/\.bash_logout)\b/, reason: "shell profile modification" },
	{ pattern: />>?\s*(\/etc\/profile|\/etc\/environment|\/etc\/bash\.bashrc)\b/, reason: "system profile modification" },
	{ pattern: /\|\s*crontab\s*-/i, reason: "cron job creation" },
	{ pattern: /\bcrontab\s+-[^l\s]/i, reason: "cron job mutation" },
	{ pattern: /npm\s+config\s+set\s+strict-ssl\s+false/i, reason: "TLS verification weakening" },
	{ pattern: /git\s+config\b[^\n]*\bsslVerify\s+false/i, reason: "git TLS verification weakening" },
	{ pattern: /\b(curl|wget)\b[^\n]*(--insecure|--no-check-certificate)\b/i, reason: "HTTP certificate verification weakening" },
	{ pattern: /\brm\s+[^\n]*-[a-z]*r[a-z]*f[a-z]*\s+\/(bin|boot|dev|etc|lib|lib64|media|mnt|opt|proc|run|sbin|srv|sys|tmp|usr|var)\b/i, reason: "irreversible deletion outside the workspace" },
	{ pattern: /\bfind\s+\/(bin|boot|dev|etc|lib|lib64|media|mnt|opt|proc|run|sbin|srv|sys|tmp|usr|var)\b[^\n]*\s-delete\b/i, reason: "system-wide delete outside the workspace" },
	{ pattern: />>?\s*~\/\.ssh\/authorized_keys\b/i, reason: "SSH key injection" },
];

// Field names inherited from pi-auto-mode's Jev-only config. Still accepted on read.
type LegacyConfigFields = {
	jevModel?: unknown;
	jevBaseUrl?: unknown;
	jevBlockThreshold?: unknown;
	jevTimeoutMs?: unknown;
};

type RawConfig = Partial<Record<keyof SafelyConfig, unknown>> & LegacyConfigFields;

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function mergeConfig(input: Partial<SafelyConfig> | null | undefined): SafelyConfig {
	const raw = input as RawConfig | null | undefined;
	// A legacy config that only carries jev* fields predates provider selection and
	// always meant TypeSafe, so infer that instead of silently switching it to OpenRouter.
	const hasLegacyJevFields = raw?.jevModel !== undefined || raw?.jevBaseUrl !== undefined;
	const rawProvider = raw?.provider;
	const provider: SystemOneProvider = isSystemOneProvider(rawProvider)
		? rawProvider
		: hasLegacyJevFields
			? "typesafe"
			: DEFAULT_PROVIDER;
	const providerDefaults = SYSTEM_ONE_PROVIDERS[provider];
	const blockThreshold = typeof raw?.blockThreshold === "number" ? raw.blockThreshold : raw?.jevBlockThreshold;
	const timeoutMs = typeof raw?.timeoutMs === "number" ? raw.timeoutMs : raw?.jevTimeoutMs;
	const config = {
		enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
		failOpen: typeof raw?.failOpen === "boolean" ? raw.failOpen : DEFAULT_CONFIG.failOpen,
		maxConsecutiveDenials:
			typeof raw?.maxConsecutiveDenials === "number" && raw.maxConsecutiveDenials > 0
				? Math.floor(raw.maxConsecutiveDenials)
				: DEFAULT_CONFIG.maxConsecutiveDenials,
		maxTotalDenials:
			typeof raw?.maxTotalDenials === "number" && raw.maxTotalDenials > 0
				? Math.floor(raw.maxTotalDenials)
				: DEFAULT_CONFIG.maxTotalDenials,
		maxTranscriptLines:
			typeof raw?.maxTranscriptLines === "number" && raw.maxTranscriptLines > 0
				? Math.floor(raw.maxTranscriptLines)
				: DEFAULT_CONFIG.maxTranscriptLines,
		allowlistedTools:
			Array.isArray(raw?.allowlistedTools) && raw.allowlistedTools.length > 0
				? raw.allowlistedTools.map((value) => String(value))
				: [...DEFAULT_CONFIG.allowlistedTools],
		environment:
			Array.isArray(raw?.environment) && raw.environment.length > 0
				? raw.environment.map((value) => String(value))
				: [...DEFAULT_CONFIG.environment],
		allowRules:
			Array.isArray(raw?.allowRules) && raw.allowRules.length > 0
				? raw.allowRules.map((value) => String(value))
				: [...DEFAULT_CONFIG.allowRules],
		denyRules:
			Array.isArray(raw?.denyRules) && raw.denyRules.length > 0
				? raw.denyRules.map((value) => String(value))
				: [...DEFAULT_CONFIG.denyRules],
		provider,
		model: nonEmptyString(raw?.model) ?? nonEmptyString(raw?.jevModel) ?? providerDefaults.defaultModel,
		baseUrl: (nonEmptyString(raw?.baseUrl) ?? nonEmptyString(raw?.jevBaseUrl) ?? providerDefaults.baseUrl).replace(/\/+$/, ""),
		blockThreshold:
			typeof blockThreshold === "number" && blockThreshold >= 0 && blockThreshold <= 1
				? blockThreshold
				: DEFAULT_CONFIG.blockThreshold,
		timeoutMs:
			typeof timeoutMs === "number" && timeoutMs > 0
				? Math.floor(timeoutMs)
				: DEFAULT_CONFIG.timeoutMs,
	};
	return config as SafelyConfig;
}

/** The config file currently in effect, or undefined when built-in defaults apply. */
function getConfigPath(cwd: string): string | undefined {
	// Project-local config takes precedence over global; within a scope, pi-safely
	// names take precedence over legacy pi-auto-mode names.
	for (const relativePath of ALL_CONFIG_RELATIVE_PATHS) {
		const path = resolve(cwd, relativePath);
		if (existsSync(path)) return path;
	}
	// Global fallback so pi-safely can be configured once for all projects.
	for (const path of [GLOBAL_CONFIG_PATH, LEGACY_GLOBAL_CONFIG_PATH]) {
		if (existsSync(path)) return path;
	}
	return undefined;
}

/**
 * Where saveConfig writes: the pi-safely-named file in the same scope as the config in
 * effect. Saving over a legacy auto-mode.json therefore migrates it to safely.json
 * (which then takes precedence) and leaves the legacy file untouched.
 */
function getConfigWritePath(cwd: string): string {
	const current = getConfigPath(cwd);
	if (!current) return resolve(cwd, CONFIG_RELATIVE_PATHS[0]);
	if (current === LEGACY_GLOBAL_CONFIG_PATH) return GLOBAL_CONFIG_PATH;
	const legacyIndex = LEGACY_CONFIG_RELATIVE_PATHS.findIndex((relativePath) => current === resolve(cwd, relativePath));
	return legacyIndex === -1 ? current : resolve(cwd, CONFIG_RELATIVE_PATHS[legacyIndex]);
}

function loadConfig(cwd: string): SafelyConfig {
	const path = getConfigPath(cwd);
	if (!path) return { ...DEFAULT_CONFIG };

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SafelyConfig>;
		return mergeConfig(parsed);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(cwd: string, config: SafelyConfig): void {
	const path = getConfigWritePath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function flattenUserContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function flattenAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text?: string } => !!block && typeof block === "object" && "type" in block)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function collectAssistantToolCalls(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((block): block is { type: string; name?: string; arguments?: unknown; input?: unknown } =>
			!!block && typeof block === "object" && "type" in block,
		)
		.filter((block) => block.type === "toolCall" || block.type === "tool_use")
		.map((block) => {
			const input = "arguments" in block ? block.arguments : block.input;
			return `${String(block.name ?? "tool")} ${safeJson(input, 1200)}`;
		});
}

function safeJson(value: unknown, maxLength = 4000): string {
	const seen = new WeakSet<object>();
	const json = JSON.stringify(
		value,
		(_key, current) => {
			if (typeof current === "string") {
				return truncateMiddle(current, Math.floor(maxLength / 4));
			}
			if (Array.isArray(current)) {
				return current.slice(0, 20);
			}
			if (current && typeof current === "object") {
				if (seen.has(current)) return "[Circular]";
				seen.add(current);
			}
			return current;
		},
		2,
	);
	return truncateMiddle(json ?? "{}", maxLength);
}

function truncateMiddle(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	const head = Math.max(0, Math.floor(maxLength * 0.65));
	const tail = Math.max(0, maxLength - head - 18);
	return `${text.slice(0, head)}\n… [truncated] …\n${text.slice(text.length - tail)}`;
}

function buildTranscript(ctx: ExtensionContext, maxLines: number): string {
	const lines: string[] = [];

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };

		if (message.role === "user") {
			const text = flattenUserContent(message.content).trim();
			if (text) lines.push(`User: ${truncateMiddle(text, 2000)}`);
			continue;
		}

		if (message.role === "assistant") {
			const text = flattenAssistantText(message.content).trim();
			if (text) lines.push(`Assistant: ${truncateMiddle(text, 2000)}`);
			for (const toolCall of collectAssistantToolCalls(message.content)) {
				lines.push(`AssistantAction: ${toolCall}`);
			}
		}
	}

	return lines.slice(-maxLines).join("\n");
}

function normalizeAllowlistedToolEntry(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const direct = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	if (/^[a-z0-9_-]+$/i.test(direct)) return direct.toLowerCase();

	const match = direct.match(/^([A-Za-z0-9_-]+)(?:\(.*\))?$/);
	if (!match?.[1]) return undefined;
	return match[1].toLowerCase();
}

function extractClaudeAllowEntries(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const root = input as {
		permissions?: { allow?: unknown; allowedTools?: unknown };
		allowedTools?: unknown;
		allow?: unknown;
	};

	const buckets = [root.permissions?.allow, root.permissions?.allowedTools, root.allowedTools, root.allow];
	const results: string[] = [];
	for (const bucket of buckets) {
		if (!Array.isArray(bucket)) continue;
		for (const entry of bucket) {
			const normalized = normalizeAllowlistedToolEntry(entry);
			if (normalized) results.push(normalized);
		}
	}
	return results;
}

function readClaudeAllowlistedTools(paths: string[]): string[] {
	const tools = new Set<string>();

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
			for (const tool of extractClaudeAllowEntries(parsed)) {
				tools.add(tool);
			}
		} catch {
			// ignore invalid claude settings
		}
	}

	return [...tools];
}

function getClaudeProjectAllowlistedTools(cwd: string): string[] {
	return readClaudeAllowlistedTools(PROJECT_CLAUDE_SETTINGS_FILES.map((relativePath) => resolve(cwd, relativePath)));
}

function getClaudeGlobalAllowlistedTools(): string[] {
	return readClaudeAllowlistedTools(GLOBAL_CLAUDE_SETTINGS_FILES);
}

function getEffectiveAllowlistedTools(cwd: string, config: SafelyConfig): string[] {
	const tools = new Set<string>();
	for (const tool of config.allowlistedTools) {
		const normalized = normalizeAllowlistedToolEntry(tool);
		if (normalized) tools.add(normalized);
	}
	for (const tool of getClaudeProjectAllowlistedTools(cwd)) {
		tools.add(tool);
	}
	for (const tool of getClaudeGlobalAllowlistedTools()) {
		tools.add(tool);
	}
	return [...tools];
}

function resolveToolPath(cwd: string, inputPath: unknown): string | undefined {
	if (typeof inputPath !== "string" || inputPath.trim() === "") return undefined;
	const raw = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	return resolve(cwd, raw);
}

function isSafetyControlFile(path: string, cwd: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	if (ALL_CONFIG_RELATIVE_PATHS.some((relativePath) => normalized.endsWith(`/${relativePath}`))) return true;
	if (!normalized.includes("/.pi/extensions/")) return false;
	const file = basename(normalized).toLowerCase();
	const roots = ["pi-safely", "pi-auto-mode"].map((name) => resolve(cwd, name).replace(/\\/g, "/"));
	return file.includes("safely") || file.includes("auto-mode") || roots.some((root) => normalized.startsWith(root));
}

function checkHardDeny(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command.trim() : "";
		for (const rule of HARD_DENY_BASH_PATTERNS) {
			if (rule.pattern.test(command)) return rule.reason;
		}
	}

	if (toolName === "write" || toolName === "edit") {
		const resolvedPath = resolveToolPath(cwd, input.path);
		if (!resolvedPath) return undefined;
		if (PROFILE_PATHS.has(resolvedPath) || SYSTEM_PROFILE_PATHS.has(resolvedPath)) return "shell profile modification";
		if (resolvedPath === resolve(HOME, ".ssh/authorized_keys")) return "SSH key injection";
		if (isSafetyControlFile(resolvedPath, cwd)) return "pi-safely self-modification";
	}

	return undefined;
}

function formatAction(toolName: string, input: Record<string, unknown>): string {
	return `${toolName} ${safeJson(input, 6000)}`;
}

function buildClassifierState(
	ctx: ExtensionContext,
	config: SafelyConfig,
	transcript: string,
	action: string,
): Record<string, unknown> {
	return {
		working_directory: ctx.cwd,
		recent_conversation: transcript || "(no prior transcript)",
		proposed_action: action,
		policy: {
			default: "Allow unless a deny rule clearly applies and no allow exception applies.",
			environment: config.environment,
			allow_exceptions: config.allowRules,
			principles: [
				"Judge the exact proposed action against the user's stated task and explicit instructions.",
				"Ambiguous requests do not authorize a more dangerous interpretation.",
				"Questions are not consent, and agent-inferred parameters are not user-approved parameters.",
				"If a composite action has a blocked part, the whole action violates that rule.",
				"Do not treat inefficiency, repetition, or low-quality work as a safety violation.",
			],
		},
	};
}

function restoreState(ctx: ExtensionContext, enabledDefault: boolean): SafelyState {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i] as { type: string; customType?: string; data?: Partial<SafelyState> };
		if (entry.type !== "custom" || !entry.data) continue;
		if (entry.customType !== STATE_ENTRY_TYPE && entry.customType !== LEGACY_STATE_ENTRY_TYPE) continue;
		return {
			enabled: entry.data.enabled ?? enabledDefault,
			consecutiveDenials: entry.data.consecutiveDenials ?? 0,
			totalDenials: entry.data.totalDenials ?? 0,
			actionCount: entry.data.actionCount ?? 0,
			overrideCount: entry.data.overrideCount ?? 0,
			lastDecision: entry.data.lastDecision,
			lastReason: entry.data.lastReason,
			recentDenials: Array.isArray(entry.data.recentDenials) ? entry.data.recentDenials.slice(-8) : [],
		};
	}

	return {
		enabled: enabledDefault,
		consecutiveDenials: 0,
		totalDenials: 0,
		actionCount: 0,
		overrideCount: 0,
		recentDenials: [],
	};
}

function formatStatus(state: SafelyState, config: SafelyConfig): string {
	if (!state.enabled) return "safely off";
	if (state.totalDenials > 0 || state.overrideCount > 0) {
		return `safely ${state.consecutiveDenials}/${config.maxConsecutiveDenials} • ${state.totalDenials}/${config.maxTotalDenials} • override:${state.overrideCount}`;
	}
	return "safely on";
}

function credentialHint(provider: SystemOneProvider): string {
	return `run /login and choose ${provider === "typesafe" ? "TypeSafe AI" : "OpenRouter"}`;
}

function statusText(state: SafelyState, config: SafelyConfig, cwd: string, hasCredential: boolean): string {
	const configuredAllowlist = config.allowlistedTools.join(", ");
	const claudeProjectAllowlist = getClaudeProjectAllowlistedTools(cwd);
	const claudeGlobalAllowlist = getClaudeGlobalAllowlistedTools();
	const effectiveAllowlist = getEffectiveAllowlistedTools(cwd, config);
	return [
		`enabled: ${state.enabled ? "yes" : "no"}`,
		`classifier: ${config.provider}/${config.model}`,
		`endpoint: ${config.baseUrl}/v1/systemone`,
		`${SYSTEM_ONE_PROVIDERS[config.provider].label} credential: ${hasCredential ? "configured" : `missing (${credentialHint(config.provider)})`}`,
		`block threshold: ${config.blockThreshold.toFixed(2)}`,
		`consecutive denials: ${state.consecutiveDenials}/${config.maxConsecutiveDenials}`,
		`total denials: ${state.totalDenials}/${config.maxTotalDenials}`,
		`overrides: ${state.overrideCount}`,
		`last decision: ${state.lastDecision ?? "(none)"}`,
		`last reason: ${state.lastReason ?? "(none)"}`,
		`failOpen: ${config.failOpen ? "yes" : "no"}`,
		`configured allowlisted tools: ${configuredAllowlist || "(none)"}`,
		`claude project allowlisted tools: ${claudeProjectAllowlist.join(", ") || "(none)"}`,
		`claude global allowlisted tools: ${claudeGlobalAllowlist.join(", ") || "(none)"}`,
		`config file: ${getConfigPath(cwd) ?? "(none, using built-in defaults)"}`,
		`effective allowlisted tools: ${effectiveAllowlist.join(", ") || "(none)"}`,
	].join("\n");
}

function pushDenial(state: SafelyState, denial: DenialRecord): void {
	state.recentDenials = [...state.recentDenials.slice(-7), denial];
}

function denialHistoryText(state: SafelyState): string {
	if (state.recentDenials.length === 0) return "No pi-safely denials recorded in this session.";

	return [...state.recentDenials]
		.reverse()
		.map((denial) => {
			const time = new Date(denial.timestamp).toLocaleString();
			const outcome = denial.overridden ? "overridden" : "blocked";
			return `${time} • ${outcome} • ${denial.kind} • ${denial.toolName}\n${denial.reason}`;
		})
		.join("\n\n");
}

// Captured from the default export so module-level helpers can report
// blocking UI to the Herdr integration (herdr-agent-state.ts), which
// refcounts "herdr:blocked" events into the pane's blocked status.
let extensionApi: ExtensionAPI | undefined;

function herdrBlockStart(label: string): void {
	try {
		extensionApi?.events.emit("herdr:blocked", { active: true, label });
	} catch {
		// Herdr integration absent or event bus unavailable; status reporting is best-effort.
	}
}

function herdrBlockEnd(): void {
	try {
		extensionApi?.events.emit("herdr:blocked", { active: false });
	} catch {
		// Best-effort; see herdrBlockStart.
	}
}

async function promptDenialOverride(
	ctx: ExtensionContext,
	toolName: string,
	reason: string,
	actionSummary: string,
): Promise<"block" | "allow-once" | "disable-and-allow"> {
	if (!ctx.hasUI) return "block";
	herdrBlockStart(`pi-safely denied ${toolName}`);
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select(
			`pi-safely denied ${toolName}\n\nReason:\n${truncateMiddle(reason, 500)}\n\nAction:\n${truncateMiddle(actionSummary, 800)}\n\nWhat do you want to do?`,
			["Block", "Allow once", "Disable pi-safely + allow"],
		);
	} finally {
		herdrBlockEnd();
	}

	if (choice === "Allow once") return "allow-once";
	if (choice === "Disable pi-safely + allow") return "disable-and-allow";
	return "block";
}

async function finalizeDeniedAction(
	ctx: ExtensionContext,
	config: SafelyConfig,
	state: SafelyState,
	denial: DenialRecord,
	actionSummary: string,
	persistState: () => void,
	updateUi: () => void,
): Promise<{ block: true; reason: string } | undefined> {
	const overrideDecision = await promptDenialOverride(ctx, denial.toolName, denial.reason, actionSummary);

	if (overrideDecision !== "block") {
		denial.overridden = true;
		state.consecutiveDenials = 0;
		if (denial.kind === "quota") {
			state.totalDenials = Math.max(0, config.maxTotalDenials - 1);
		} else {
			state.totalDenials = Math.max(0, state.totalDenials - 1);
		}
		state.overrideCount += 1;
		state.lastDecision = "allow";
		state.lastReason = `User override: ${denial.reason}`;
		if (overrideDecision === "disable-and-allow") {
			state.enabled = false;
			config.enabled = false;
			saveConfig(ctx.cwd, config);
		}
		persistState();
		updateUi();
		ctx.ui.notify(
			overrideDecision === "disable-and-allow"
				? "pi-safely disabled and this action was allowed once"
				: "pi-safely override: action allowed once",
			"warning",
		);
		return undefined;
	}

	state.lastDecision = "deny";
	state.lastReason = denial.reason;
	persistState();
	updateUi();

	if (denial.kind === "quota") {
		return {
			block: true,
			reason: `[safely] Session paused: reached ${config.maxTotalDenials} blocked actions. Last reason: ${denial.reason}`,
		};
	}

	if (state.consecutiveDenials >= config.maxConsecutiveDenials) {
		return {
			block: true,
			reason: `[safely] PAUSED after ${config.maxConsecutiveDenials} consecutive blocks. Last reason: ${denial.reason}. Total blocks: ${state.totalDenials}/${config.maxTotalDenials}.`,
		};
	}

	return {
		block: true,
		reason: `[safely] Blocked (${state.consecutiveDenials}/${config.maxConsecutiveDenials} consecutive, ${state.totalDenials}/${config.maxTotalDenials} total): ${denial.reason}`,
	};
}

export default function safelyExtension(pi: ExtensionAPI) {
	extensionApi = pi;
	// Auth-only provider: no Jev entry is exposed in the generative model picker,
	// but /login can persist a dedicated TypeSafe key in Pi's native auth.json.
	// OpenRouter needs no registration; Pi ships it as a built-in provider.
	pi.registerProvider("typesafe", {
		name: "TypeSafe AI",
		apiKey: "$TYPESAFE_API_KEY",
		models: [],
	});

	let config = { ...DEFAULT_CONFIG };
	let state: SafelyState = {
		enabled: true,
		consecutiveDenials: 0,
		totalDenials: 0,
		actionCount: 0,
		overrideCount: 0,
		recentDenials: [],
	};
	function persistState(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, state);
	}

	function recordDenial(denial: DenialRecord): void {
		pushDenial(state, denial);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (ctx.hasUI) {
			const text = formatStatus(state, config);
			const styled = !state.enabled
				? ctx.ui.theme.fg("dim", text)
				: state.totalDenials > 0 || state.overrideCount > 0
					? ctx.ui.theme.fg("warning", text)
					: ctx.ui.theme.fg("accent", text);
			ctx.ui.setStatus("safely", styled);
		}
	}

	async function getClassifierApiKey(ctx: ExtensionContext): Promise<string | undefined> {
		return await ctx.modelRegistry.getApiKeyForProvider(config.provider);
	}

	async function maybeWarnMissingCredential(ctx: ExtensionContext): Promise<void> {
		if (!state.enabled || !ctx.hasUI) return;
		if (!(await getClassifierApiKey(ctx))) {
			const { label } = SYSTEM_ONE_PROVIDERS[config.provider];
			ctx.ui.notify(`pi-safely needs a ${label} key: ${credentialHint(config.provider)}.`, "warning");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		state = restoreState(ctx, config.enabled);
		updateUi(ctx);
		await maybeWarnMissingCredential(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${AUTO_MODE_GUIDANCE}`,
		};
	});

	const usage = `Usage: /safely [status|history|on|off|toggle|reset|reload|provider [${Object.keys(SYSTEM_ONE_PROVIDERS).join("|")}]|model [model-id]]`;

	pi.registerCommand("safely", {
		description: "Control pi-safely: status, history, on, off, toggle, reset, reload, provider, model",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [subcommand, ...rest] = trimmed.split(/\s+/).filter(Boolean);
			const command = (subcommand ?? "status").toLowerCase();
			const remainder = rest.join(" ").trim();

			if (command === "status") {
				const apiKey = await getClassifierApiKey(ctx);
				ctx.ui.notify(statusText(state, config, ctx.cwd, Boolean(apiKey)), "info");
				return;
			}

			if (command === "history") {
				ctx.ui.notify(denialHistoryText(state), "info");
				return;
			}

			if (command === "on") {
				state.enabled = true;
				config.enabled = true;
				saveConfig(ctx.cwd, config);
				persistState();
				updateUi(ctx);
				await maybeWarnMissingCredential(ctx);
				ctx.ui.notify("pi-safely enabled", "info");
				return;
			}

			if (command === "off") {
				state.enabled = false;
				config.enabled = false;
				saveConfig(ctx.cwd, config);
				persistState();
				updateUi(ctx);
				ctx.ui.notify("pi-safely disabled", "warning");
				return;
			}

			if (command === "toggle") {
				state.enabled = !state.enabled;
				config.enabled = state.enabled;
				saveConfig(ctx.cwd, config);
				persistState();
				updateUi(ctx);
				if (state.enabled) await maybeWarnMissingCredential(ctx);
				ctx.ui.notify(`pi-safely ${state.enabled ? "enabled" : "disabled"}`, state.enabled ? "info" : "warning");
				return;
			}

			if (command === "reset") {
				state = {
					...state,
					consecutiveDenials: 0,
					totalDenials: 0,
					actionCount: 0,
					overrideCount: 0,
					lastDecision: undefined,
					lastReason: undefined,
					recentDenials: [],
				};
				persistState();
				updateUi(ctx);
				ctx.ui.notify("pi-safely counters reset", "info");
				return;
			}

			if (command === "reload") {
				config = loadConfig(ctx.cwd);
				state.enabled = config.enabled;
				persistState();
				updateUi(ctx);
				ctx.ui.notify(`Reloaded ${getConfigPath(ctx.cwd) ?? "built-in defaults"}`, "info");
				return;
			}

			if (command === "provider") {
				if (remainder) {
					const provider = remainder.toLowerCase();
					if (!isSystemOneProvider(provider)) {
						ctx.ui.notify(usage, "error");
						return;
					}
					// Model IDs and endpoints are provider-specific, so switching resets both.
					config.provider = provider;
					config.model = SYSTEM_ONE_PROVIDERS[provider].defaultModel;
					config.baseUrl = SYSTEM_ONE_PROVIDERS[provider].baseUrl;
					saveConfig(ctx.cwd, config);
					ctx.ui.notify(`pi-safely classifier set to ${config.provider}/${config.model}`, "info");
					await maybeWarnMissingCredential(ctx);
					return;
				}
				ctx.ui.notify(`pi-safely provider: ${config.provider} (${config.baseUrl})`, "info");
				return;
			}

			if (command === "model") {
				if (remainder) {
					config.model = remainder;
					saveConfig(ctx.cwd, config);
					ctx.ui.notify(`pi-safely classifier set to ${config.provider}/${config.model}`, "info");
					return;
				}
				ctx.ui.notify(`pi-safely classifier: ${config.provider}/${config.model}`, "info");
				return;
			}

			ctx.ui.notify(usage, "error");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) return undefined;
		if (ctx.signal?.aborted) {
			return { block: true, reason: "Cancelled" };
		}

		state.actionCount += 1;
		const actionSummary = formatAction(event.toolName, event.input as Record<string, unknown>);
		const allowlist = new Set(getEffectiveAllowlistedTools(ctx.cwd, config));

		if (allowlist.has(event.toolName)) {
			state.consecutiveDenials = 0;
			state.lastDecision = "allow";
			state.lastReason = `Allowlisted tool: ${event.toolName}`;
			persistState();
			updateUi(ctx);
			return undefined;
		}

		if (state.totalDenials >= config.maxTotalDenials) {
			const denial: DenialRecord = {
				timestamp: Date.now(),
				toolName: event.toolName,
				reason: `Reached ${config.maxTotalDenials} blocked actions for this session`,
				kind: "quota",
			};
			recordDenial(denial);
			return await finalizeDeniedAction(ctx, config, state, denial, actionSummary, persistState, () => updateUi(ctx));
		}

		const hardDenyReason = checkHardDeny(event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		if (hardDenyReason) {
			state.consecutiveDenials += 1;
			state.totalDenials += 1;
			const denial: DenialRecord = {
				timestamp: Date.now(),
				toolName: event.toolName,
				reason: hardDenyReason,
				kind: "hard-deny",
			};
			recordDenial(denial);
			return await finalizeDeniedAction(ctx, config, state, denial, actionSummary, persistState, () => updateUi(ctx));
		}

		const apiKey = await getClassifierApiKey(ctx);
		if (!apiKey) {
			const { label } = SYSTEM_ONE_PROVIDERS[config.provider];
			state.lastDecision = config.failOpen ? "allow" : "deny";
			state.lastReason = `No ${label} API key available`;
			persistState();
			updateUi(ctx);
			if (config.failOpen) return undefined;

			state.consecutiveDenials += 1;
			state.totalDenials += 1;
			const denial: DenialRecord = {
				timestamp: Date.now(),
				toolName: event.toolName,
				reason: `No ${label} API key available and failOpen=false; ${credentialHint(config.provider)}`,
				kind: "setup",
			};
			recordDenial(denial);
			return await finalizeDeniedAction(ctx, config, state, denial, actionSummary, persistState, () => updateUi(ctx));
		}

		const transcript = buildTranscript(ctx, config.maxTranscriptLines);
		const classifierState = buildClassifierState(ctx, config, transcript, actionSummary);

		try {
			const result = await classifyWithSystemOne({
				provider: config.provider,
				apiKey,
				baseUrl: config.baseUrl,
				model: config.model,
				state: classifierState,
				denyRules: config.denyRules,
				blockThreshold: config.blockThreshold,
				timeoutMs: config.timeoutMs,
				signal: ctx.signal,
			});
			const reason = `${config.model}: ${result.reason}`;

			if (!result.shouldBlock) {
				state.consecutiveDenials = 0;
				state.lastDecision = "allow";
				state.lastReason = reason;
				persistState();
				updateUi(ctx);
				return undefined;
			}

			state.consecutiveDenials += 1;
			state.totalDenials += 1;
			const denial: DenialRecord = {
				timestamp: Date.now(),
				toolName: event.toolName,
				reason,
				kind: "classifier",
			};
			recordDenial(denial);
			return await finalizeDeniedAction(ctx, config, state, denial, actionSummary, persistState, () => updateUi(ctx));
		} catch (error) {
			state.lastDecision = config.failOpen ? "allow" : "deny";
			state.lastReason = error instanceof Error ? error.message : String(error);
			persistState();
			updateUi(ctx);
			if (config.failOpen) return undefined;

			state.consecutiveDenials += 1;
			state.totalDenials += 1;
			const denial: DenialRecord = {
				timestamp: Date.now(),
				toolName: event.toolName,
				reason: `Classifier failure (${config.provider}/${config.model}): ${state.lastReason}`,
				kind: "setup",
			};
			recordDenial(denial);
			return await finalizeDeniedAction(ctx, config, state, denial, actionSummary, persistState, () => updateUi(ctx));
		}
	});
}
