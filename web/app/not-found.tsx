import Link from "next/link";

export default function NotFound() {
	return (
		<>
			<h1>找不到這一頁</h1>
			<p className="lede">沒有任何已發布的日期、事件或項目對應到這個網址。</p>
			<p>
				<Link href="/">今日</Link> · <Link href="/history">歷史</Link> ·{" "}
				<Link href="/search">搜尋</Link>
			</p>
		</>
	);
}
