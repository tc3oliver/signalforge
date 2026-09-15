import Link from "next/link";
import { loadRecentItemsForAdmin } from "../../lib/queries.ts";
import { displaySourceName, dispositionLabel, formatScore, formatTimeOfDay } from "../../lib/format.ts";
import { preview } from "../../lib/untrusted.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata = { title: "Admin — SignalForge" };

export default async function AdminHomePage() {
	const recent = await loadRecentItemsForAdmin(25);
	return (
		<>
			<h1>Admin</h1>
			<p className="lede">
				Operational views over the pipeline&apos;s own record of what it did. Everything here is
				read from Postgres; nothing on this page can start a run or call a model.
			</p>

			<div className="cards">
				<div className="card">
					<h3>
						<Link href="/admin/runs">Runs</Link>
					</h3>
					<p className="host">
						Daily run status, curator/editor stage timings and models, fallback events, scan
						coverage and draft validation failures.
					</p>
				</div>
				<div className="card">
					<h3>
						<Link href="/admin/sources">Sources</Link>
					</h3>
					<p className="host">
						Collector health, last run, consecutive failures, fetched vs inserted, latency and
						sources disabled for a missing credential.
					</p>
				</div>
				<div className="card">
					<h3>Item trace</h3>
					<p className="host">
						Why did this item not reach the brief? Enter an item id for its full path:
						scanned → decision → story → selection.
					</p>
					<form action="/admin/item" method="get">
						<input type="text" name="id" placeholder="item id" aria-label="Item id" />
						<button type="submit">Trace</button>
					</form>
				</div>
			</div>

			<section aria-labelledby="admin-recent">
				<h2 id="admin-recent">Recently collected, latest brief date</h2>
				{recent.length === 0 ? (
					<p className="lede">
						No items were collected after the latest brief date&apos;s first run.
					</p>
				) : (
					<ul className="sources">
						{recent.map((item) => (
							<li key={item.itemId}>
								<Link href={`/admin/item/${encodeURIComponent(item.itemId)}`}>{item.title}</Link>
								<div className="host">
									{displaySourceName(item.sourceName)} · fetched {formatTimeOfDay(item.fetchedAt)} ·{" "}
									{dispositionLabel(item.disposition)}
									{item.importance === undefined
										? ""
										: ` · importance ${formatScore(item.importance)}`}
								</div>
								{item.summary ? <div className="host">{preview(item.summary, 140)}</div> : null}
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}
