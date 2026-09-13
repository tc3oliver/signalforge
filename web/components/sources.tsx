import Link from "next/link";
import type { NormalizedItem } from "../../src/schemas/item.ts";
import { displayHost, safeExternalUrl } from "../lib/untrusted.ts";

/*
 * Source titles and URLs are provider-supplied and untrusted. Titles are text
 * nodes, which JSX escapes; URLs go through safeExternalUrl, which admits only
 * http(s) — a `javascript:` href from a feed would otherwise be a stored XSS.
 *
 * rel="noreferrer" matters beyond hygiene here: this reader is a private LAN
 * page, and its URL must not leak to whatever the source links to.
 */

export function SourceLink({ item }: { item: NormalizedItem }) {
	const href = safeExternalUrl(item.url);
	const host = displayHost(item.url);
	return (
		<>
			<span className="host">{item.sourceName}</span>
			{" · "}
			{href ? (
				<a href={href} target="_blank" rel="noreferrer noopener nofollow external">
					{item.title}
				</a>
			) : (
				<span>{item.title}</span>
			)}
			{host ? <span className="host"> ({host})</span> : null}
			{href ? null : <span className="host"> (no usable link recorded)</span>}
			{" · "}
			<Link href={`/admin/item/${encodeURIComponent(item.id)}`} className="host">
				trace
			</Link>
		</>
	);
}

export function SourceList({
	items,
	unresolvedIds = [],
}: {
	items: readonly NormalizedItem[];
	unresolvedIds?: readonly string[];
}) {
	if (items.length === 0 && unresolvedIds.length === 0) return null;
	return (
		<ul className="sources">
			{items.map((item) => (
				<li key={item.id}>
					<SourceLink item={item} />
				</li>
			))}
			{unresolvedIds.map((id) => (
				<li key={id}>
					<span className="mono">{id}</span>
					<span className="host"> — cited by the story but missing from the item store</span>
				</li>
			))}
		</ul>
	);
}
