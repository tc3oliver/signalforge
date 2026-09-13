import type { DailyManifest } from "../schemas/manifest.ts";

export interface SourceValidator {
	itemExists(id: string): boolean;
	factExists(id: string): boolean;
	unknownItemIds(ids: string[]): string[];
	unknownFactIds(ids: string[]): string[];
}

/** Membership oracle over the frozen manifest — the only thing that decides
 * whether a cited id is real. */
export function createSourceValidator(manifest: DailyManifest): SourceValidator {
	const itemIds = new Set(manifest.items.map((i) => i.id));
	const factIds = new Set(manifest.facts.map((f) => f.factId));
	const unknown = (known: Set<string>) => (ids: string[]) => {
		const out: string[] = [];
		for (const id of ids) if (!known.has(id) && !out.includes(id)) out.push(id);
		return out;
	};
	return {
		itemExists: (id) => itemIds.has(id),
		factExists: (id) => factIds.has(id),
		unknownItemIds: unknown(itemIds),
		unknownFactIds: unknown(factIds),
	};
}
