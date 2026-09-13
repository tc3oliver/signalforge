import Link from "next/link";

export default function NotFound() {
	return (
		<>
			<h1>Not found</h1>
			<p className="lede">
				No published brief, story or item matches that address in this lineage.
			</p>
			<p>
				<Link href="/">Latest brief</Link> · <Link href="/history">History</Link> ·{" "}
				<Link href="/search">Search</Link>
			</p>
		</>
	);
}
