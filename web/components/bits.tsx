import type { ReactNode } from "react";

/** Small presentational primitives shared by every page. */

export function Tag({
	tone = "neutral",
	children,
}: {
	tone?: "neutral" | "accent" | "ok" | "warn" | "bad";
	children: ReactNode;
}) {
	const cls = tone === "neutral" ? "tag" : `tag ${tone}`;
	return <span className={cls}>{children}</span>;
}

/** A labelled block of brief prose. The value is always rendered as a text node. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<p className="field">
			<span className="field-label">{label}</span>
			{children}
		</p>
	);
}

export function Empty({ children }: { children: ReactNode }) {
	return <p className="lede">{children}</p>;
}
