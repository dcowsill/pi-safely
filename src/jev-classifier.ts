export type JevNoulQuestion = {
	type: "noul";
	instructions: string;
	criteria: {
		true: string;
		false: string;
	};
};

export type JevNoulAnswer = {
	type: "noul";
	noul: number;
};

export type JevClassificationResult = {
	shouldBlock: boolean;
	reason: string;
	matches: Array<{ rule: string; probability: number }>;
	model?: string;
	inputTokens?: number;
};

export type ClassifyWithJevOptions = {
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

type JevSystemOneResponse = {
	model?: unknown;
	answers?: unknown;
	usage?: {
		input_tokens?: unknown;
	};
};

function questionName(index: number): string {
	return `deny_${String(index + 1).padStart(3, "0")}`;
}

export function buildPolicyQuestions(denyRules: string[]): Record<string, JevNoulQuestion> {
	if (denyRules.length === 0) {
		throw new Error("Jev classifier requires at least one deny rule");
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
): JevClassificationResult {
	if (!Number.isFinite(blockThreshold) || blockThreshold < 0 || blockThreshold > 1) {
		throw new Error(`Invalid Jev block threshold: ${blockThreshold}`);
	}
	if (denyRules.length === 0) {
		throw new Error("Jev classifier requires at least one deny rule");
	}

	const scored = denyRules.map((rule, index) => {
		const name = questionName(index);
		const answer = answers[name] as Partial<JevNoulAnswer> | undefined;
		if (answer?.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul)) {
			throw new Error(`Invalid or missing Jev answer: ${name}`);
		}
		if (answer.noul < 0 || answer.noul > 1) {
			throw new Error(`Out-of-range Jev probability for ${name}: ${answer.noul}`);
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
			reason: `Jev matched deny rule at ${top.probability.toFixed(2)}: ${top.rule}${suffix}`,
			matches,
		};
	}

	return {
		shouldBlock: false,
		reason: `Jev found no deny rule at or above ${blockThreshold.toFixed(2)} (highest ${highest.probability.toFixed(2)}: ${highest.rule})`,
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

export async function classifyWithJev(options: ClassifyWithJevOptions): Promise<JevClassificationResult> {
	const questions = buildPolicyQuestions(options.denyRules);
	const fetchImpl = options.fetchImpl ?? fetch;
	const timedSignal = combineWithTimeout(options.signal, options.timeoutMs);
	let response: Response;

	try {
		response = await fetchImpl(`${options.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
			method: "POST",
			headers: {
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
			throw new Error(`TypeSafe API request timed out after ${options.timeoutMs}ms`, { cause: error });
		}
		throw error;
	} finally {
		timedSignal.cleanup();
	}

	if (!response.ok) {
		throw new Error(`TypeSafe API returned HTTP ${response.status}`);
	}

	let payload: JevSystemOneResponse;
	try {
		payload = (await response.json()) as JevSystemOneResponse;
	} catch (error) {
		throw new Error("TypeSafe API returned invalid JSON", { cause: error });
	}
	if (!payload.answers || typeof payload.answers !== "object" || Array.isArray(payload.answers)) {
		throw new Error("TypeSafe API response did not contain an answers object");
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
	};
}
