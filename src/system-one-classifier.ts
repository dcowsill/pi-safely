// System One decision-model client. TypeSafe (Jev) and OpenRouter (Jev, Cloudflare
// Clef, ...) serve the same `POST /v1/systemone` wire format; providers differ only in
// base URL, credential, model IDs, and optional attribution headers.

export type SystemOneProvider = "openrouter" | "typesafe";

export const SYSTEM_ONE_PROVIDERS: Record<
	SystemOneProvider,
	{ label: string; baseUrl: string; defaultModel: string; headers: Record<string, string> }
> = {
	openrouter: {
		label: "OpenRouter",
		baseUrl: "https://openrouter.ai/api",
		defaultModel: "cloudflare/clef",
		headers: {
			"HTTP-Referer": "https://github.com/dcowsill/pi-safely",
			"X-Title": "pi-safely",
		},
	},
	typesafe: {
		label: "TypeSafe",
		baseUrl: "https://api.typesafe.ai",
		defaultModel: "jev-1.13.0",
		headers: {},
	},
};

export function isSystemOneProvider(value: unknown): value is SystemOneProvider {
	return typeof value === "string" && Object.hasOwn(SYSTEM_ONE_PROVIDERS, value);
}

export type NoulQuestion = {
	type: "noul";
	instructions: string;
	criteria: {
		true: string;
		false: string;
	};
};

export type NoulAnswer = {
	type: "noul";
	noul: number;
};

export type ClassificationResult = {
	shouldBlock: boolean;
	reason: string;
	matches: Array<{ rule: string; probability: number }>;
	model?: string;
	inputTokens?: number;
	costUsd?: number;
};

export type ClassifyWithSystemOneOptions = {
	provider: SystemOneProvider;
	apiKey: string;
	baseUrl: string;
	model: string;
	state: Record<string, unknown>;
	denyRules: string[];
	blockThreshold: number;
	timeoutMs: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
};

type SystemOneResponse = {
	model?: unknown;
	answers?: unknown;
	usage?: {
		input_tokens?: unknown;
		cost?: unknown;
	};
};

function questionName(index: number): string {
	return `deny_${String(index + 1).padStart(3, "0")}`;
}

export function buildPolicyQuestions(denyRules: string[]): Record<string, NoulQuestion> {
	if (denyRules.length === 0) {
		throw new Error("System One classifier requires at least one deny rule");
	}

	return Object.fromEntries(
		denyRules.map((rule, index) => [
			questionName(index),
			{
				type: "noul" as const,
				instructions:
					"Does the proposed action violate this specific block rule after applying the policy's allow exceptions?",
				criteria: {
					true: `The action clearly matches this block rule and no allow exception authorizes it: ${rule}`,
					false: `The action does not match this block rule, or an allow exception clearly authorizes it: ${rule}`,
				},
			},
		]),
	);
}

export function evaluatePolicyAnswers(
	denyRules: string[],
	answers: Record<string, unknown>,
	blockThreshold: number,
): ClassificationResult {
	if (!Number.isFinite(blockThreshold) || blockThreshold < 0 || blockThreshold > 1) {
		throw new Error(`Invalid block threshold: ${blockThreshold}`);
	}
	if (denyRules.length === 0) {
		throw new Error("System One classifier requires at least one deny rule");
	}

	const scored = denyRules.map((rule, index) => {
		const name = questionName(index);
		const answer = answers[name] as Partial<NoulAnswer> | undefined;
		if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
			throw new Error(`Invalid or missing System One answer: ${name}`);
		}
		if (answer.noul < 0 || answer.noul > 1) {
			throw new Error(`Out-of-range System One probability for ${name}: ${answer.noul}`);
		}
		return { rule, probability: answer.noul };
	}).sort((a, b) => b.probability - a.probability);

	const matches = scored.filter((entry) => entry.probability >= blockThreshold);
	const highest = scored[0];
	if (matches.length > 0) {
		const top = matches[0];
		const suffix = matches.length > 1 ? ` (+${matches.length - 1} other matched rule${matches.length === 2 ? "" : "s"})` : "";
		return {
			shouldBlock: true,
			reason: `Matched deny rule at ${top.probability.toFixed(2)}: ${top.rule}${suffix}`,
			matches,
		};
	}

	return {
		shouldBlock: false,
		reason: `No deny rule at or above ${blockThreshold.toFixed(2)} (highest ${highest.probability.toFixed(2)}: ${highest.rule})`,
		matches: [],
	};
}

function combineWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
	signal: AbortSignal;
	cleanup: () => void;
	didTimeout: () => boolean;
} {
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
		didTimeout: () => timedOut,
	};
}

// Both providers return `{ error: { message } }` on failure; surface it when present.
async function readErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: { message?: unknown } | string };
		const message = typeof body.error === "string" ? body.error : body.error?.message;
		return typeof message === "string" && message.trim() ? message.trim().split("\n")[0] : undefined;
	} catch {
		return undefined;
	}
}

export async function classifyWithSystemOne(options: ClassifyWithSystemOneOptions): Promise<ClassificationResult> {
	const questions = buildPolicyQuestions(options.denyRules);
	const fetchImpl = options.fetchImpl ?? fetch;
	const { label, headers: providerHeaders } = SYSTEM_ONE_PROVIDERS[options.provider];
	const timedSignal = combineWithTimeout(options.signal, options.timeoutMs);
	let response: Response;

	try {
		response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
			method: "POST",
			headers: {
				...providerHeaders,
				Authorization: `Bearer ${options.apiKey}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				state: options.state,
				model: options.model,
				questions,
			}),
			signal: timedSignal.signal,
		});
	} catch (error) {
		if (timedSignal.didTimeout()) {
			throw new Error(`${label} API request timed out after ${options.timeoutMs}ms`, { cause: error });
		}
		throw error;
	} finally {
		timedSignal.cleanup();
	}

	if (!response.ok) {
		const message = await readErrorMessage(response);
		throw new Error(`${label} API returned HTTP ${response.status}${message ? `: ${message}` : ""}`);
	}

	let payload: SystemOneResponse;
	try {
		payload = (await response.json()) as SystemOneResponse;
	} catch (error) {
		throw new Error(`${label} API returned invalid JSON`, { cause: error });
	}
	if (!payload.answers || typeof payload.answers !== "object" || Array.isArray(payload.answers)) {
		throw new Error(`${label} API response did not contain an answers object`);
	}

	const result = evaluatePolicyAnswers(
		options.denyRules,
		payload.answers as Record<string, unknown>,
		options.blockThreshold,
	);
	return {
		...result,
		model: typeof payload.model === "string" ? payload.model : undefined,
		inputTokens:
			typeof payload.usage?.input_tokens === "number" ? payload.usage.input_tokens : undefined,
		costUsd: typeof payload.usage?.cost === "number" ? payload.usage.cost : undefined,
	};
}
