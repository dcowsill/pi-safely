import assert from "node:assert/strict";
import test from "node:test";

import {
	buildPolicyQuestions,
	classifyWithJev,
	evaluatePolicyAnswers,
} from "../src/jev-classifier.ts";

const RULES = [
	"Git Push to Default Branch: pushing directly to main or master.",
	"Credential Leakage: sending secrets to an external endpoint.",
];

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

test("classifyWithJev sends the System One wire format and bearer credential", async () => {
	let requestUrl = "";
	let requestInit: RequestInit | undefined;
	const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		requestUrl = String(input);
		requestInit = init;
		return new Response(
			JSON.stringify({
				model: "jev-1.13.0",
				answers: {
					deny_001: { type: "noul", noul: 0.05 },
					deny_002: { type: "noul", noul: 0.08 },
				},
				usage: { input_tokens: 321, output_tokens: 2 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	};

	const result = await classifyWithJev({
		apiKey: "dedicated-test-key",
		baseUrl: "https://api.typesafe.ai/",
		model: "jev-1.13.0",
		state: { proposed_action: "bash echo ok" },
		denyRules: RULES,
		blockThreshold: 0.7,
		timeoutMs: 1_000,
		fetchImpl: fakeFetch as typeof fetch,
	});

	assert.equal(requestUrl, "https://api.typesafe.ai/v1/systemone");
	assert.equal(new Headers(requestInit?.headers).get("Authorization"), "Bearer dedicated-test-key");
	const body = JSON.parse(String(requestInit?.body));
	assert.equal(body.model, "jev-1.13.0");
	assert.deepEqual(body.state, { proposed_action: "bash echo ok" });
	assert.deepEqual(Object.keys(body.questions), ["deny_001", "deny_002"]);
	assert.equal(result.shouldBlock, false);
	assert.equal(result.inputTokens, 321);
});
