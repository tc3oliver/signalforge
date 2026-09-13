"use client";

/**
 * Rendering errors are almost always a database problem here (pool exhausted,
 * container stopped). The message is shown verbatim because this reader is
 * loopback-only and single-user: hiding it would only cost debugging time.
 */
export default function ErrorBoundary({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	return (
		<>
			<h1>這一頁無法顯示</h1>
			<p className="lede">{error.message}</p>
			{error.digest ? <p className="mono">digest {error.digest}</p> : null}
			<button type="button" onClick={reset}>
				再試一次
			</button>
		</>
	);
}
