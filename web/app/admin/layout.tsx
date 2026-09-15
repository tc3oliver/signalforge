import { notFound } from "next/navigation";
import { ADMIN_ENABLED } from "../../lib/admin.ts";

export const dynamic = "force-dynamic";

/*
 * The site is indexable; these pages are not. They are operational views of runs
 * and sources, and they inherit the root layout's robots directive unless they
 * override it. Declared beside the ADMIN_ENABLED gate for the same reason: a new
 * route under /admin is covered when it exists, not when someone remembers.
 */
export const metadata = { robots: { index: false, follow: false } };

/**
 * Gating here rather than in each page means a new route added under /admin is
 * covered the moment it exists, instead of the moment someone remembers.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
	if (!ADMIN_ENABLED) notFound();
	return <>{children}</>;
}
