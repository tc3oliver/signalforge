import { Tag } from "../../../components/bits.tsx";
import { loadSourcesPage } from "../../../lib/queries.ts";
import { formatDuration, formatInstant } from "../../../lib/format.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "Sources — SignalForge" };

export default async function SourcesPage() {
	const { sources, throughput, recentRuns } = await loadSourcesPage();

	// A disabled source that declares required secrets is almost always waiting
	// on a credential rather than deliberately switched off; the two cases look
	// identical in the table otherwise.
	const credentialBlocked = sources.filter((s) => !s.enabled && s.requiredSecrets.length > 0);

	return (
		<>
			<h1>Sources</h1>
			<p className="lede">
				{sources.length} configured collector{sources.length === 1 ? "" : "s"}. Throughput is
				measured over the last 7 days. Secret names are shown; secret values live in the
				keychain and are never stored or displayed.
			</p>

			{credentialBlocked.length > 0 ? (
				<section className="panel alert" aria-labelledby="sources-blocked">
					<h2 id="sources-blocked" style={{ marginTop: 0, border: "none" }}>
						Disabled, credentials required
					</h2>
					<ul className="plain tight">
						{credentialBlocked.map((source) => (
							<li key={source.collectorId}>
								<span className="mono">{source.collectorId}</span> — needs{" "}
								{source.requiredSecrets.map((secret) => (
									<span key={secret} className="mono">
										{secret}{" "}
									</span>
								))}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{sources.length === 0 ? (
				<p className="lede">No source configs are registered.</p>
			) : (
				<div className="scroll-x">
					<table>
						<thead>
							<tr>
								<th>Collector</th>
								<th>Type</th>
								<th>State</th>
								<th>Last health</th>
								<th>Last run</th>
								<th>Fail streak</th>
								<th>Runs</th>
								<th>Fetched</th>
								<th>Inserted</th>
								<th>Avg latency</th>
								<th>Secrets</th>
							</tr>
						</thead>
						<tbody>
							{sources.map((source) => {
								const stats = throughput.get(source.collectorId);
								return (
									<tr key={source.collectorId}>
										<td className="mono">{source.collectorId}</td>
										<td>{source.sourceType}</td>
										<td>
											{source.enabled ? (
												<Tag tone="ok">enabled</Tag>
											) : (
												<Tag tone="bad">disabled</Tag>
											)}
										</td>
										<td>
											{source.lastHealth === undefined ? (
												"—"
											) : (
												<Tag
													tone={
														source.lastHealth === "OK"
															? "ok"
															: source.lastHealth === "FAILED"
																? "bad"
																: "warn"
													}
												>
													{source.lastHealth}
												</Tag>
											)}
										</td>
										<td>{formatInstant(source.lastRunAt)}</td>
										<td>
											{source.consecutiveFailures > 0 ? (
												<Tag tone="bad">{source.consecutiveFailures}</Tag>
											) : (
												"0"
											)}
										</td>
										<td>{stats?.runs ?? 0}</td>
										<td>{stats?.itemsFetched ?? 0}</td>
										<td>{stats?.itemsInserted ?? 0}</td>
										<td>{stats ? formatDuration(stats.avgLatencyMs) : "—"}</td>
										<td className="mono host">
											{source.requiredSecrets.length === 0
												? "none"
												: source.requiredSecrets.join(", ")}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			<section aria-labelledby="sources-errors">
				<h2 id="sources-errors">Latest errors</h2>
				{(() => {
					const withErrors = [...throughput.values()].filter((t) => t.lastError !== undefined);
					if (withErrors.length === 0) {
						return <p className="lede">No collector has reported an error in the window.</p>;
					}
					return (
						<ul className="plain tight">
							{withErrors.map((entry) => (
								<li key={entry.collectorId}>
									<span className="mono">{entry.collectorId}</span> — {entry.lastError}
								</li>
							))}
						</ul>
					);
				})()}
			</section>

			<section aria-labelledby="sources-recent">
				<h2 id="sources-recent">Recent collection runs</h2>
				{recentRuns.length === 0 ? (
					<p className="lede">No collection runs recorded.</p>
				) : (
					<div className="scroll-x">
						<table>
							<thead>
								<tr>
									<th>Collector</th>
									<th>Health</th>
									<th>Fetched</th>
									<th>Latency</th>
									<th>Started</th>
									<th>Finished</th>
									<th>Warnings</th>
								</tr>
							</thead>
							<tbody>
								{recentRuns.map((run) => (
									<tr key={run.collectionRunId}>
										<td className="mono">{run.collectorId}</td>
										<td>
											<Tag
												tone={
													run.health === "OK" ? "ok" : run.health === "FAILED" ? "bad" : "warn"
												}
											>
												{run.health}
											</Tag>
										</td>
										<td>{run.itemsFetched}</td>
										<td>{formatDuration(run.latencyMs)}</td>
										<td>{formatInstant(run.startedAt)}</td>
										<td>{formatInstant(run.finishedAt)}</td>
										<td>{run.warnings.length > 0 ? run.warnings.join("; ") : "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</>
	);
}
