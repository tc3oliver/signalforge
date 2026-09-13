import { createElement, type ReactNode } from "react";

/**
 * Stands in for next/link under vitest. The real component needs a router
 * context that only exists inside a Next server; for rendering assertions an
 * anchor with the same href is the whole of what matters.
 */
export default function Link({
	href,
	children,
	...rest
}: {
	href: string;
	children?: ReactNode;
	className?: string;
}) {
	return createElement("a", { href, ...rest }, children);
}
