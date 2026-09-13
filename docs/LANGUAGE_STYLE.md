# Language style

The design basis for everything a reader sees: the web reader's own copy today,
and the Editor's output language after the observation freeze.

**Status.** This document is a specification. During the freeze (2026-09-13 to
2026-09-18) it is applied only to deterministic presentation copy in `web/`.
The Editor runtime does not load it, and `src/editor/prompt.ts` and the agent
skill under `agent/skills/` are unchanged. Wiring it into the Editor is a
tracked post-freeze change, see `INTELLIGENCE_BACKLOG.md`, "Post-freeze: Chinese
editorial style integration".

Where this document and the skill's `references/writing-style.md` overlap, the
skill text is what the model currently sees. The two are meant to converge
after the freeze; until then this file is the target, not the runtime.

## What the reader is

A single technical reader in Taiwan who opens the page every morning. They read
fast, they know the field, and they resent being told things they already know
or being sold a story. The test for any sentence is:

> 一個台灣工程師每天早上打開，會不會覺得這是正常中文？

not whether it maps word for word onto an English original.

## Rules

### 1. Traditional Chinese, Taiwan usage

- 正體中文，台灣用語。「資訊」不是「信息」，「軟體」不是「軟件」，「程式」不是「程序」，
  「伺服器」不是「服務器」，「網路」不是「網絡」，「品質」不是「質量」。
- Full-width punctuation in Chinese text: 「，」「。」「：」「（）」「「」」. Half-width
  punctuation only inside English or code.
- One space between Chinese and any Latin word, number or unit: 「vLLM 0.12 釋出」,
  「50 億美元」, 「3 個來源」. No space before full-width punctuation.
- Numbers use Arabic digits, with Chinese units where natural: 「50 億」, 「12 %」 is
  written 「12%」.

### 2. Direct, concise, technical

- The first sentence gives the conclusion. No run-up, no background, no 「隨著……」.
- One fact per sentence. Two facts, two sentences.
- Active voice with a concrete subject: 「GitHub 修正了」, not 「該問題已被修正」.
- Numbers when there is a number; otherwise say there is none. Never 「顯著」 or
  「大幅」 as a stand-in for a figure you do not have.

### 3. English technical terms stay in English

Established terms are names, not phrases to translate. Keep:

AI, LLM, Agent, MCP, API, CI/CD, RAG, GPU, GitHub, Homebrew, vLLM, SGLang,
llama.cpp, ROCm, CUDA, MLX, Qwen, DeepSeek, OpenAI, Anthropic, Bitcoin / BTC,
Ethereum / ETH, Solana / SOL, DeFi, ETF, RWA, open-weight, context window,
inference, serving, quantization, benchmark, post-mortem.

Do not produce:

- 大型語言模型代理執行體 (write: LLM Agent)
- 模型上下文協定 (write: MCP)
- 分散式金融協議棧 (write: DeFi)
- 上下文視窗 (write: context window)

Translate only when the Chinese term is the one people actually use
(「推論」 for inference in prose is fine; 「推論成本」 is natural) or when the
English term is genuinely unknown to the reader and a gloss helps once.

### 4. No presentation or report meta-language

The product is not a 簡報, a report, a paper or a newspaper, and the text must
never refer to itself as one. Banned in reader-facing copy and in Editor output:

本簡報、今日簡報、這份簡報、本報告、本文、本文將……、本次整理、以下內容、
綜合以上、綜合來看、整體而言、總的來說、綜上所述、從上述事件可以看出、
從今天的新聞可以看出、今日簡報指出、這份內容顯示。

The product's own name for what it publishes, when a name is unavoidable in UI
copy, is 「今天的重點」, 「今日重點」, 「每日重點整理」 or 「每日摘要」. Prose should
not need one.

**Talk about the world, not about the brief.**

> ❌ 本簡報顯示今日 AI 領域出現多項重要發展。
> ✅ 今天沒有重大模型發布；較值得注意的是 Agent 安全研究與 GitHub 基礎設施問題。

> ❌ 今日簡報呈現出前沿技術演進與工程現實之間的強烈對比。
> ✅ 今天 AI 領域的焦點落在 Agent 安全與工程基礎設施。GitHub 的服務事故暴露 CI/CD
>    對集中式平台的依賴；Bengio 的新研究則把 Agent 欺瞞問題拉回實際工程層面。

### 5. No filler, no hype, no generic AI phrasing

Banned as openers or connectors when they carry no information:

值得注意的是、值得一提的是、不可否認的是、這無疑是、這標誌著、這意味著一個新時代、
在當今快速發展的……、隨著 AI 技術的日益成熟、在這個資訊爆炸的時代、
讓我們拭目以待、未來發展值得關注、有待進一步觀察、此次事件顯示、這反映出。

Banned unless the evidence actually supports the claim:

強烈對比、關鍵轉折點、新的時代正在形成、格局正在快速演變、歷史性、里程碑、
革命性、顛覆。

> ❌ 值得注意的是，智譜完成 50 億美元融資。
> ✅ 智譜完成 50 億美元融資，但目前更像資本與算力擴張訊號，尚未帶來新的模型或技術能力。

> ❌ 從上述事件可以看出 Web3 法規持續發展。
> ✅ CLARITY Act 的爭議已從監管框架轉向官員利益衝突條款，下一個關鍵點是修正案能否進入最終版本。

### 6. Fact and analysis are visibly different

- A fact names its source or its number. An analysis names what it rests on.
- 「官方未說明影響範圍」 is a fact. 「相關發展有待觀察」 is filler.
- Uncertainty is stated as its source and degree (「單一匿名貼文，無其他來源」),
  never hidden in vague wording.
- Any number that is not a structured fact is not written; see the skill's
  rule on `factRefs`.

### 7. A quiet day may sound quiet

The opening paragraph must answer, in order:

1. Was there a genuinely major event today?
2. What is the most important technical change?
3. Which items are industry news rather than technical progress?
4. If nothing much happened, say so.

Allowed, and preferred over manufactured significance:

- 「今天沒有重大模型發布。」
- 「Crypto 市場今天沒有值得單獨列入的實質新進展。」
- 「AI Agent 是今天最值得關注的主題。」

### 8. Financing is not technical progress

A funding round, a valuation, an IPO decision or an executive quote is
industry news. It may be important, but the text must say what it changes for
the reader, and must not be dressed up as a capability change. 「完成 50 億美元
融資」 is not 「推出新模型」.

### 9. Readability

- Titles: the event, 15 to 30 characters, not the source headline translated.
- One-line takeaways on the dashboard: one sentence, no colon-led label.
- No exclamation marks, no emoji, no rhetorical questions, no 「我們」.
- Badges use the short form (新、更新、升溫、已結束、反轉、確認、未證實); prose and
  tooltips use the full form (新事件、新進展、情勢升高、已告一段落、出現反轉、
  已確認、尚未證實).
- 「可信度」, never 「信心」: the reader wants to know how well the evidence
  supports a claim, not how sure the model felt.

## Reader-facing vocabulary

The single mapping the web reader uses. Enum values never appear on a public
page; they may appear on `/admin`.

| Working name | Reader sees |
|---|---|
| Today | 今日 |
| History | 歷史 |
| Signals | 趨勢 |
| Search | 搜尋 |
| Today in 60 seconds | 60 秒掌握今天 |
| Must Know | 今日必看 |
| What Changed | 最新變化 |
| What Happened | 發生了什麼 |
| Why It Matters | 為什麼值得注意 |
| Impact | 可能影響 |
| Sources | 資料來源 |
| Emerging Signal | 值得觀察的趨勢 |
| Watch Next | 接下來關注 |
| New Since Morning | 今日新增 |
| Daily Analysis | 今日觀察 |
| AI / LLM | AI / LLM |
| Developer / Open Source | 開發工具 / Open Source |
| Research | 研究 |
| Crypto / Market | Crypto / Web3 |
| Macro | 總體經濟 |
| Companies | 產業動態 |
| HIGH / MEDIUM / LOW importance | 重要 / 一般 / 次要 |
| High / Medium / Low confidence | 可信度高 / 可信度中等 / 可信度低 |
| OPEN / RESOLVED / DORMANT | 追蹤中 / 已結束 / 暫無動靜 |
| emerging / strengthening / confirmed / fading | 剛浮現 / 持續增強 / 已成形 / 逐漸淡出 |

The markdown artifact written by `src/renderer/markdown.ts` keeps its English
headings; it is part of the production run's output and is frozen.

## Applying this to the Editor (post-freeze)

When the freeze ends, the intended integration is:

1. Fold rules 4, 5, 7 and 8 into `agent/skills/daily-intelligence/references/writing-style.md`
   (the skill already bans 「值得注意的是」 and 「總的來說」; it does not yet ban
   self-reference or hype, and does not require the quiet-day answer).
2. Add a deterministic check on Editor output for the banned meta-phrases in
   `dailyAnalysis` and story prose, reported in the run's manual review, not
   enforced as a hard rejection until a week of observation shows the false
   positive rate.
3. Re-run the gold evaluation unchanged. This is a style change and must not
   move selection metrics; if it does, the change is wrong.

None of that happens before 2026-09-18.
