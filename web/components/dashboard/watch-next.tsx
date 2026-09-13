/** The editor's watch list, one arrow per line. Text only, as the schema stores it. */
export function WatchNext({ entries }: { entries: readonly string[] }) {
	if (entries.length === 0) return null;
	return (
		<section className="block" aria-labelledby="watch-next">
			<h2 id="watch-next" className="block-label">
				Watch next
			</h2>
			<ul className="watch-list">
				{entries.map((entry) => (
					<li key={entry}>
						<span className="arrow" aria-hidden="true">
							→
						</span>
						<span>{entry}</span>
					</li>
				))}
			</ul>
		</section>
	);
}
