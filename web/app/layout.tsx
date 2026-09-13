import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ADMIN_ENABLED } from "../lib/admin.ts";
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
				<a href="#content" className="skip-link">
					Skip to content
				</a>
				<header className="masthead">
					<div className="masthead-inner">
						<Link href="/" className="wordmark">
							SignalForge
						</Link>
						<nav aria-label="Sections" className="primary-nav">
							<Link href="/">Today</Link>
							<Link href="/history">History</Link>
							<Link href="/signals">Signals</Link>
						</nav>
						<div className="masthead-tools">
							<form action="/search" method="get" role="search" className="search-compact">
								<label htmlFor="site-search" className="sr-only">
									Search briefs and items
								</label>
								<input id="site-search" type="search" name="q" placeholder="Search" />
								<button type="submit" className="sr-only">
									Search
								</button>
							</form>
							{ADMIN_ENABLED ? (
								<Link href="/admin" className="admin-link">
									Admin
								</Link>
							) : null}
						</div>
					</div>
				</header>
				<main id="content" className="shell">
					{children}
				</main>
				<footer className="site">
					Served from Postgres. Every number is read from the structured fact store by
					reference; no language model runs while a page is rendered.{" "}
					<Link href="/feed.xml">Atom feed</Link>
				</footer>
			</body>
		</html>
	);
}
