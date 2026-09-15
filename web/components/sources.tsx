import Link from "next/link";
import { ADMIN_ENABLED } from "../lib/admin.ts";
import type { NormalizedItem } from "../../src/schemas/item.ts";
import { displaySourceName } from "../lib/format.ts";
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
			<span className="host">{displaySourceName(item.sourceName)}</span>
			{" · "}
			{href ? (
				<a href={href} target="_blank" rel="noreferrer noopener nofollow external">
					{item.title}
				</a>
			) : (
				<span>{item.title}</span>
			)}
			{host ? <span className="host"> ({host})</span> : null}
			{href ? null : <span className="host">（未記錄可用連結）</span>}
			{ADMIN_ENABLED ? (
				<>
					{" · "}
					<Link href={`/admin/item/${encodeURIComponent(item.id)}`} className="host">
						trace
					</Link>
				</>
			) : null}
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
					<span className="host">：事件有引用，但項目庫中找不到這個項目</span>
				</li>
			))}
		</ul>
	);
}
