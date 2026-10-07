import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPolicyQuestions,
	classifyWithSystemOne,
	evaluatePolicyAnswers,
} from "../src/system-one-classifier.ts";
import { mergeConfig } from "../extensions/safely.ts";

const RULES = [
	"Git Push to Default Branch: pushing directly to main or master.",
	"Credential Leakage: sending secrets to an external endpoint.",
];

function fakeSystemOne(body: unknown, status = 200) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(input), init });
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	};
	return { calls, fetchImpl: fetchImpl as typeof fetch };
}

const LOW_ANSWERS = {
	deny_001: { type: "noul", noul: 0.05 },
	deny_002: { type: "noul", noul: 0.08 },
};

test("buildPolicyQuestions creates one independent Noul per deny rule", () => {
	const questions = buildPolicyQuestions(RULES);
	assert.deepEqual(Object.keys(questions), ["deny_001", "deny_002"]);
	assert.equal(questions.deny_001.type, "noul");
	assert.match(questions.deny_001.criteria.true, /Git Push to Default Branch/);
	assert.match(questions.deny_002.criteria.false, /allow exception/);
});

test("evaluatePolicyAnswers blocks on the strongest rule at or above threshold", () => {
	const result = evaluatePolicyAnswers(
		RULES,
		{
			deny_001: { type: "noul", noul: 0.91 },
			deny_002: { type: "noul", noul: 0.12 },
		},
		0.7,
	);
	assert.equal(result.shouldBlock, true);
	assert.equal(result.matches.length, 1);
	assert.match(result.reason, /0\.91.*Git Push to Default Branch/);
});

test("evaluatePolicyAnswers allows when every rule is below threshold", () => {
	const result = evaluatePolicyAnswers(
		RULES,
		{
			deny_001: { type: "noul", noul: 0.11 },
			deny_002: { type: "noul", noul: 0.22 },
		},
		0.7,
	);
	assert.equal(result.shouldBlock, false);
	assert.match(result.reason, /highest 0\.22/);
});

test("evaluatePolicyAnswers rejects incomplete responses", () => {
	assert.throws(
		() => evaluatePolicyAnswers(RULES, { deny_001: { type: "noul", noul: 0.1 } }, 0.7),
		/deny_002/,
	);
});

test("TypeSafe: sends the System One wire format and bearer credential", async () => {
	const { calls, fetchImpl } = fakeSystemOne({
		model: "jev-1.13.0",
		answers: LOW_ANSWERS,
		usage: { input_tokens: 321, output_tokens: 2 },
	});

	const result = await classifyWithSystemOne({
		provider: "typesafe",
		apiKey: "dedicated-test-key",
		baseUrl: "https://api.typesafe.ai/",
		model: "jev-1.13.0",
		state: { proposed_action: "bash echo ok" },
		denyRules: RULES,
		blockThreshold: 0.7,
		timeoutMs: 1_000,
		fetchImpl,
	});

	assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
	const headers = new Headers(calls[0].init?.headers);
	assert.equal(headers.get("Authorization"), "Bearer dedicated-test-key");
	assert.equal(headers.get("X-Title"), null);
	const body = JSON.parse(String(calls[0].init?.body));
	assert.equal(body.model, "jev-1.13.0");
	assert.deepEqual(body.state, { proposed_action: "bash echo ok" });
	assert.deepEqual(Object.keys(body.questions), ["deny_001", "deny_002"]);
	assert.equal(result.shouldBlock, false);
	assert.equal(result.inputTokens, 321);
});

test("OpenRouter: same wire format, attribution headers, and reported cost", async () => {
	// Response shape captured from a live cloudflare/clef call on OpenRouter.
	const { calls, fetchImpl } = fakeSystemOne({
		model: "cloudflare/clef",
		answers: {
			deny_001: { type: "noul", noul: 0.9914 },
			deny_002: { type: "noul", noul: 0.1123 },
		},
		usage: { input_tokens: 236, output_tokens: 0, cost: 0.00005664 },
		id: "gen-dec-123",
		provider: "Cloudflare",
	});

	const result = await classifyWithSystemOne({
		provider: "openrouter",
		apiKey: "sk-or-test",
		baseUrl: "https://openrouter.ai/api",
		model: "cloudflare/clef",
		state: { proposed_action: "bash git push --force origin main" },
		denyRules: RULES,
		blockThreshold: 0.7,
		timeoutMs: 1_000,
		fetchImpl,
	});

	assert.equal(calls[0].url, "https://openrouter.ai/api/v1/systemone");
	const headers = new Headers(calls[0].init?.headers);
	assert.equal(headers.get("Authorization"), "Bearer sk-or-test");
	assert.equal(headers.get("X-Title"), "pi-safely");
	assert.equal(JSON.parse(String(calls[0].init?.body)).model, "cloudflare/clef");
	assert.equal(result.shouldBlock, true);
	assert.equal(result.model, "cloudflare/clef");
	assert.equal(result.costUsd, 0.00005664);
});

test("HTTP errors surface the provider's error message", async () => {
	const { fetchImpl } = fakeSystemOne(
		{ error: { message: "0 endpoints out of 1 requested are available\nmore detail", code: 404 } },
		404,
	);

	await assert.rejects(
		classifyWithSystemOne({
			provider: "openrouter",
			apiKey: "sk-or-test",
			baseUrl: "https://openrouter.ai/api",
			model: "~typesafe/jev-latest",
			state: {},
			denyRules: RULES,
			blockThreshold: 0.7,
			timeoutMs: 1_000,
			fetchImpl,
		}),
		/^Error: OpenRouter API returned HTTP 404: 0 endpoints out of 1 requested are available$/,
	);
});

test("mergeConfig defaults to OpenRouter + Clef", () => {
	const config = mergeConfig({});
	assert.equal(config.provider, "openrouter");
	assert.equal(config.model, "cloudflare/clef");
	assert.equal(config.baseUrl, "https://openrouter.ai/api");
});

test("mergeConfig uses per-provider defaults when only provider is set", () => {
	const config = mergeConfig({ provider: "typesafe" });
	assert.equal(config.model, "jev-1.13.0");
	assert.equal(config.baseUrl, "https://api.typesafe.ai");
});

test("mergeConfig reads legacy pi-auto-mode jev* fields as TypeSafe", () => {
	const config = mergeConfig({
		jevModel: "jev-preview",
		jevBaseUrl: "https://api.typesafe.ai/",
		jevBlockThreshold: 0.5,
		jevTimeoutMs: 4_000,
	} as never);
	assert.equal(config.provider, "typesafe");
	assert.equal(config.model, "jev-preview");
	assert.equal(config.baseUrl, "https://api.typesafe.ai");
	assert.equal(config.blockThreshold, 0.5);
	assert.equal(config.timeoutMs, 4_000);
	assert.equal("jevModel" in config, false);
});

test("mergeConfig: explicit provider wins over legacy inference", () => {
	const config = mergeConfig({ provider: "openrouter", jevModel: "jev-1.13.0" } as never);
	assert.equal(config.provider, "openrouter");
	assert.equal(config.model, "jev-1.13.0");
});
