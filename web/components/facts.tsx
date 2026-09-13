import type { StructuredFact } from "../../src/schemas/fact.ts";
import { factLine, resolveFactRefs } from "../lib/facts.ts";
import { formatInstant } from "../lib/format.ts";

/**
 * Renders a story's cited numbers. The story supplies fact ids only; the values
 * below are read out of `structured_facts`, so no figure on this page can have
 * come from model prose. An id with no stored fact is shown as a gap, never
 * filled in.
 */
export function FactList({
	factRefs,
	facts,
}: {
	factRefs: readonly string[];
	facts: readonly StructuredFact[];
}) {
	if (factRefs.length === 0) return null;
	const resolutions = resolveFactRefs(factRefs, facts);
	return (
		<ul className="facts">
			{resolutions.map((resolution) => {
				if (resolution.status === "missing") {
					return (
						<li key={resolution.factId} className="missing">
							<span className="mono">{resolution.factId}</span> — no stored value for this
							reference; nothing is shown in its place.
						</li>
					);
				}
				const line = factLine(resolution.fact);
				return (
					<li key={resolution.factId}>
						{line.label}: <span className="fact-value">{line.value}</span>
						{line.previous === undefined ? null : <> (prev {line.previous})</>}
						{line.change === undefined ? null : <> {line.change}</>}
						{" · "}
						<span className="host">as of {formatInstant(line.asOf)}</span>
					</li>
				);
			})}
		</ul>
	);
}
