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
 * The keys whose values are filesystem paths. `PATH` is colon-separated and is
 * split before checking; `ProgramArguments` is an array whose entries all
 * inherit its key.
 */
const PATH_KEYS = new Set(["ProgramArguments", "WorkingDirectory", "StandardOutPath", "StandardErrorPath", "PATH"]);

/**
 * Walks the plist in document order, pairing each `<string>` with the `<key>`
 * that governs it. Array entries keep the key of the array itself, which is
 * what makes every ProgramArguments entry checkable.
 */
function* stringValuesByKey(xml: string): Generator<{ key: string; value: string }> {
	const token = /<key>([^<]*)<\/key>|<string>([^<]*)<\/string>|<(\/?)(array|dict)>/g;
	let key = "";
	let arrayKey: string | undefined;
	let match: RegExpExecArray | null;
	while ((match = token.exec(xml)) !== null) {
		const [, keyName, stringValue, closing, container] = match;
		if (keyName !== undefined) {
			key = keyName;
			continue;
		}
		if (container === "array") {
			arrayKey = closing === "/" ? undefined : key;
			continue;
		}
		if (stringValue === undefined) continue;
		const governing = arrayKey ?? key;
		if (governing === "PATH") {
			for (const entry of stringValue.split(":")) yield { key: "PATH", value: entry };
		} else {
			yield { key: governing, value: stringValue };
		}
	}
}

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

	// Every path-shaped value must be absolute: a relative one is silently wrong
	// under launchd, which has no shell to resolve it against.
	//
	// Only the keys that actually carry paths are checked. Scanning every
	// `<string>` in the file would flag any value with a slash in it, and not
	// everything with a slash is a path -- an IANA time zone (Asia/Taipei) is
	// the case that proved it.
	for (const { key, value } of stringValuesByKey(xml)) {
		// A ProgramArguments entry without a slash is an argument, not a path.
		if (!PATH_KEYS.has(key) || !value.includes("/")) continue;
		if (!value.startsWith("/") && !value.startsWith("$")) {
			errors.push(`relative path found in plist: ${value}`);
		}
	}

	return { valid: errors.length === 0, errors };
}
