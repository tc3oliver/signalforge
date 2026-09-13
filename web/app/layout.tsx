import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { ADMIN_ENABLED } from "../lib/admin.ts";
import "./globals.css";

export const metadata: Metadata = {
	title: "SignalForge",
	description: "每日重點整理。只讀取已發布的資料，頁面呈現時不會執行任何模型。",
	// The reader is LAN/localhost only; nothing here should ever be indexed.
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
					所有內容都來自已發布的資料。每個數字都依引用從結構化事實庫讀出，頁面呈現時不會執行任何語言模型。{" "}
					<Link href="/feed.xml">Atom 訂閱</Link>
				</footer>
			</body>
		</html>
	);
}
