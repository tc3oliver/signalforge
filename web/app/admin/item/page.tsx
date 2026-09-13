import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A GET form cannot build a path segment, so the admin lookup box submits
 * `?id=` here and this page turns it into the canonical /admin/item/[id] URL.
 */
export default async function ItemLookupPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const params = await searchParams;
	const raw = params["id"];
	const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
	if (!id) redirect("/admin");
	redirect(`/admin/item/${encodeURIComponent(id)}`);
}
