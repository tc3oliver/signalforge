/**
 * Pure helpers for rendering and validating launchd plist XML.
 *
 * Kept filesystem-free on purpose: `renderPlist` and `validatePlist` are unit
 * tested directly, and the install script is the only thing that ever writes
 * the rendered output to disk.
 */

/** Substitutes every `{{TOKEN}}` occurrence in `template` from `tokens`. */
export function renderPlist(template: string, tokens: Record<string, string>): string {
	let rendered = template;
	for (const [key, value] of Object.entries(tokens)) {
		// Split/join avoids building a fresh RegExp per token and sidesteps
		// regex-special characters that can appear in a substituted path.
		rendered = rendered.split(`{{${key}}}`).join(value);
	}
	return rendered;
}

export interface PlistValidationResult {
	valid: boolean;
	errors: string[];
}

const REQUIRED_KEYS = [
	"Label",
	"ProgramArguments",
	"WorkingDirectory",
	"StandardOutPath",
	"StandardErrorPath",
	"EnvironmentVariables",
	"RunAtLoad",
] as const;

/**
 * Structural + content checks on a rendered plist. This is not a general XML
 * validator — it checks the handful of things that have actually bitten a
 * launchd job before: an unfilled token, a relative path, a missing key, and
 * a tag-balance sanity check so a botched template substitution is caught
 * before it ever reaches `launchctl bootstrap`.
 */
export function validatePlist(xml: string): PlistValidationResult {
	const errors: string[] = [];

	if (xml.includes("{{") || xml.includes("}}")) {
		errors.push("unsubstituted template token remains ({{...}})");
	}

	if (!xml.startsWith("<?xml")) {
		errors.push("missing XML declaration");
	}
	if (!xml.includes("<!DOCTYPE plist")) {
		errors.push("missing plist DOCTYPE");
	}

	// Self-closing tags (e.g. `<false/>`) never match the open-tag pattern
	// below (it requires a bare `>` or whitespace-then-attributes before the
	// `>`), so open/close counts are already self-closing-agnostic.
	const openTags = xml.match(/<([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>/g) ?? [];
	const closeTags = xml.match(/<\/([a-zA-Z][a-zA-Z0-9]*)>/g) ?? [];
	if (openTags.length !== closeTags.length) {
		errors.push("unbalanced XML tags");
	}

	for (const key of REQUIRED_KEYS) {
		if (!xml.includes(`<key>${key}</key>`)) {
			errors.push(`missing required key: ${key}`);
		}
	}

	// Every path-shaped value must be absolute. `ProgramArguments`,
	// `WorkingDirectory`, `StandardOutPath`, `StandardErrorPath` all carry
	// filesystem paths; a relative one is silently wrong under launchd
	// (there is no shell to resolve it against).
	const stringValues = xml.match(/<string>([^<]*)<\/string>/g) ?? [];
	for (const raw of stringValues) {
		const value = raw.slice("<string>".length, -"</string>".length);
		const looksLikePath = value.startsWith("/") || value.includes("/");
		if (looksLikePath && !value.startsWith("/") && !value.startsWith("$")) {
			errors.push(`relative path found in plist: ${value}`);
		}
	}

	return { valid: errors.length === 0, errors };
}
