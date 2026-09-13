import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { writeJsonAtomic } from "../runtime/atomic-json.ts";
import { DEFAULT_SEED, generateAll } from "../fixtures/generator.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function parseSeed(argv: string[]): number {
	const index = argv.indexOf("--seed");
	if (index === -1) return DEFAULT_SEED;
	const raw = argv[index + 1];
	const seed = Number(raw);
	if (raw === undefined || !Number.isFinite(seed)) {
		throw new Error("--seed requires a numeric value");
	}
	return Math.trunc(seed);
}

function main(): void {
	const seed = parseSeed(process.argv.slice(2));
	const days = generateAll(seed);

	console.log(`seed ${seed}`);
	let totalItems = 0;

	for (const { date, manifest, gold } of days) {
		const manifestPath = join(ROOT, "fixtures", "generated", date, "manifest.json");
		const goldPath = join(ROOT, "eval", "gold", `${date}.json`);
		writeJsonAtomic(manifestPath, manifest);
		writeJsonAtomic(goldPath, gold);

		const bySource = new Map<string, number>();
		for (const item of manifest.items) {
			bySource.set(item.sourceType, (bySource.get(item.sourceType) ?? 0) + 1);
		}
		const sourceSummary = [...bySource.entries()]
			.sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
			.map(([type, count]) => `${type}=${count}`)
			.join(" ");
		const important = gold.events.filter((e) => e.expectedImportant).length;
		totalItems += manifest.items.length;

		console.log(
			[
				`\n${date}`,
				`  items       ${manifest.items.length}`,
				`  sources     ${sourceSummary}`,
				`  facts       ${manifest.facts.length}`,
				`  gold events ${gold.events.length} (important ${important})`,
				`  noise items ${gold.noiseItemIds.length} (${Math.round((gold.noiseItemIds.length / manifest.items.length) * 100)}%)`,
				`  signals     ${gold.expectedEmergingSignals.length}`,
				`  wrote       ${manifestPath}`,
				`  wrote       ${goldPath}`,
			].join("\n"),
		);
	}

	console.log(`\ntotal items across ${days.length} dates: ${totalItems}`);
}

main();
