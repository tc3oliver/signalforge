import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ADMIN_ENABLED } from "../lib/admin.ts";
import "./globals.css";
import "./styles/today.css";
import "./styles/story.css";
import "./styles/reference.css";

/*
 * What a shared link says about this site. The old description was the
 * engineering guarantee ("reads published rows, runs no model"), which is true
 * and belongs in the footer, not on a LINE card: a person deciding whether to
 * tap needs to know what they will get, not how it is served.
 */
const SITE_DESCRIPTION =
	"每天早上把幾百則來源讀完，留下真正有變化的十幾件事：什麼發生了、為什麼重要、和昨天比變了什麼。每個數字都有出處。";

/*
 * Where this site lives, for absolute URLs. Next resolves the OpenGraph image
 * against this; unset, it resolves against localhost and every share card
 * comes back blank from anywhere but the machine that rendered it. The default
 * matches the reader's own bind port, so a dev server still produces a URL
 * that works locally.
 */
const SITE_URL = process.env["SIGNALFORGE_SITE_URL"]?.trim() || "http://localhost:3300";

/*
 * Next's own "metadataBase is not set" warning was the only signal that this
 * was unconfigured, and giving it a default silences that. In production an
 * unset variable means every shared link previews blank, indefinitely and with
 * nothing in the logs, so say so once at startup instead.
 */
if (process.env.NODE_ENV === "production" && !process.env["SIGNALFORGE_SITE_URL"]?.trim()) {
	console.warn(
		`[signalforge] SIGNALFORGE_SITE_URL is unset; absolute URLs fall back to ${SITE_URL}. ` +
			"Share cards and feed links will not resolve from other machines.",
	);
}

export const metadata: Metadata = {
	metadataBase: new URL(SITE_URL),
	title: "SignalForge — 每日重點",
	description: SITE_DESCRIPTION,
	openGraph: {
		title: "SignalForge",
		description: SITE_DESCRIPTION,
		siteName: "SignalForge",
		locale: "zh_TW",
		type: "website",
	},
	// Not indexed: the content is model-written and changes daily; the site is
	// meant to be shared as a link, not found through search.
	robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="zh-Hant">
			<body>
				<a href="#content" className="skip-link">
					跳到主要內容
				</a>
				<header className="masthead">
					<div className="masthead-inner">
						<Link href="/" className="wordmark">
							SignalForge
						</Link>
						<nav aria-label="主要導覽" className="primary-nav">
							<Link href="/">今日</Link>
							<Link href="/history">歷史</Link>
							<Link href="/signals">趨勢</Link>
						</nav>
						<div className="masthead-tools">
							<form action="/search" method="get" role="search" className="search-compact">
								<label htmlFor="site-search" className="sr-only">
									搜尋事件與收集項目
								</label>
								<input id="site-search" type="search" name="q" placeholder="搜尋" />
								<button type="submit" className="sr-only">
									搜尋
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
					<p>
						所有內容都來自已發布的資料。每個數字都依引用從結構化事實庫讀出，頁面呈現時不會執行任何語言模型。{" "}
						<Link href="/feed.xml">Atom 訂閱</Link>
					</p>
					{/* Plain anchors, not next/link: these leave the site, and they are
					    the route back to who built this and to the source. */}
					<p className="site-colophon">
						SignalForge 由{" "}
						<a href="https://meowcoder.com" rel="me noopener">
							Oliver Yu
						</a>{" "}
						設計與維運 ·{" "}
						<a href="https://github.com/tc3oliver/signalforge" rel="noopener">
							原始碼
						</a>{" "}
						·{" "}
						<a href="https://meowcoder.com/work/signalforge/" rel="noopener">
							案例研究
						</a>{" "}
						·{" "}
						<a href="https://study.meowcoder.com/posts/260915-signalforge-design-decisions/" rel="noopener">
							設計筆記
						</a>
					</p>
				</footer>
			</body>
		</html>
	);
}
