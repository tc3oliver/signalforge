import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
	title: "SignalForge",
	description: "Daily briefing reader. Published rows only — no model runs on a request.",
	// The reader is LAN/localhost only; nothing here should ever be indexed.
	robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="zh-Hant">
			<body>
				<header className="masthead">
					<div className="masthead-inner">
						<Link href="/" className="wordmark">
							SignalForge
						</Link>
						<nav aria-label="Sections">
							<Link href="/">Today</Link>
							<Link href="/history">History</Link>
							<Link href="/signals">Signals</Link>
							<Link href="/search">Search</Link>
							<Link href="/admin">Admin</Link>
						</nav>
						<form action="/search" method="get" role="search">
							<input
								type="search"
								name="q"
								placeholder="Search briefs and items"
								aria-label="Search briefs and items"
							/>
							<button type="submit">Search</button>
						</form>
					</div>
				</header>
				<main className="shell">{children}</main>
				<footer className="site">
					Served from Postgres. Every number is read from the structured fact store by
					reference; no language model runs while a page is rendered.{" "}
					<Link href="/feed.xml">Atom feed</Link>
				</footer>
			</body>
		</html>
	);
}
