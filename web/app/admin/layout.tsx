import { notFound } from "next/navigation";
import { ADMIN_ENABLED } from "../../lib/admin.ts";

export const dynamic = "force-dynamic";

/**
 * Gating here rather than in each page means a new route added under /admin is
 * covered the moment it exists, instead of the moment someone remembers.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
	if (!ADMIN_ENABLED) notFound();
	return <>{children}</>;
}
