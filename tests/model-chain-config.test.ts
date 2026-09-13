import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/loader.ts";
import { MODEL_CHAIN, modelKey } from "../src/runtime/model-config.ts";

/**
 * `config/agent.yaml` declares the model chain and `MODEL_CHAIN` is the
 * compiled-in default. Two declarations of the same thing drift, and this one
 * drifted silently for as long as nothing read the config at all: the yaml was
 * schema-validated and then ignored, so an operator could change providers
 * there and watch the run go out over the old ones anyway.
 *
 * The chain is now read from the config. These tests hold the two in agreement
 * so that (a) the shipped default is what the constant says it is, and (b) the
 * config remains the thing you edit to change it.
 */
describe("model chain configuration", () => {
	it("is loadable and non-empty", () => {
		const chain = loadConfig().agent.modelChain;
		expect(chain.length).toBeGreaterThan(0);
	});

	it("matches the compiled-in default, so the shipped config changes no behaviour", () => {
		const configured = loadConfig().agent.modelChain.map(modelKey);
		expect(configured).toEqual(MODEL_CHAIN.map(modelKey));
	});

	it("orders the chain as primary first, with each entry a distinct provider/model", () => {
		const keys = loadConfig().agent.modelChain.map(modelKey);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
