---
name: daily-intelligence
description: Curate a day of raw feed items into deduplicated, historically-aware stories, then write a daily intelligence brief.
---

# Daily Intelligence

一天的原始 feed 進來,兩個角色接手:**Curator** 把散落的 item 收斂成 story,
**Editor** 把 story 寫成當日簡報。兩個角色分開執行,共用同一份 ledger。

參考檔案放在 `references/`,與本檔同層。需要細節時讀對應檔案,不要憑印象:

| 檔案 | 何時讀 |
|---|---|
| `references/curation.md` | 決定一則 item 值不值得注意 |
| `references/deduplication.md` | 判斷兩則 item 是不是同一件事 |
| `references/story-clustering.md` | 取 `storyId`、選 `primarySourceIds`、拆併 cluster |
| `references/novelty.md` | 選 `changeType` |
| `references/source-quality.md` | 給 `confidence`、處理互相矛盾的報導 |
| `references/editorial-policy.md` | tier A/B/C、section 歸類、什麼不該進簡報 |
| `references/emerging-signals.md` | 抓跨來源的趨勢 |
| `references/writing-style.md` | 中文寫作規範 |
| `references/output-schema.md` | 每個 submit 工具的 payload 欄位與 enum |

---

## Role 1 — Curator

可用工具:`get_daily_inventory`、`list_unseen_items`、`get_item_detail`、`read_item_body`、
`search_items`、`find_history`、`get_story`、`list_today_stories`、`upsert_stories`、
`upsert_story`、`record_item_decisions`、`get_structured_facts`、`submit_materials`。

### 先知道錢花在哪

你的每一次工具呼叫,都會把這個 session 到目前為止的**全部**內容重送一次給模型 ——
包括你剛列出的那一整頁 item。一頁 50 則、25 次呼叫,就是同一頁被送了 25 次。
所以這份流程的核心紀律是:**每頁用最少的呼叫做完**。一次 `upsert_stories` 寫完
整頁的 story,一次 `record_item_decisions` 記完整頁的判斷。

### 主迴圈

1. `get_daily_inventory` — 先知道今天總共有多少 item、多少是提供給你的、有哪些來源。
2. `list_unseen_items`(每頁最多 50)取一批。它只列「提供給你、尚未判斷」的 item。
   若有一個便宜的 screener 先把一部分 item 判成噪音而**保留不列**,inventory 會顯示
   `screenedOutItems`;那些 item 仍在 `search_items` 找得到(結果會標 `screenedOut: true`)。
3. 對這批的**每一則**做出判斷:`IRRELEVANT` / `DUPLICATE` / `CANDIDATE`。
   多數 item 用 title + summary 就能判掉;值得深究的用 `get_item_detail`
   看紀錄,要讀內文就用 `read_item_body` 帶 `find` 跳到關鍵段落,
   不要整篇拉進 session
   (判準見 `references/curation.md`)。
4. 懷疑某則跟今天其他報導講同一件事時,用 `search_items` 找兄弟報導;
   判斷方法見 `references/deduplication.md`。**併之前先跑 Event Identity Test**:
   關係是 `SAME_EVENT` 才併;`RELATED_EVENT`(含因果、回應)各自成案;
   `BACKGROUND_CONTEXT` 不開新 story。
5. 把這頁要成案的 cluster **一次**用 `upsert_stories` 寫入。每一則 story 的歷史
   (昨天以前的 ledger)由工具替你查,結果隨回覆一起回來:
   - `NEW` 但回覆帶 `history` → 那很可能是同一條線。用回覆中的 `storyId` 重新 upsert,
     並選一個非 `NEW` 的 `changeType`(`references/novelty.md`)。
   - 非 `NEW` 卻查無歷史 → 工具直接拒絕,那則改成 `NEW`。
   拿不準時,先 `find_history` 讀舊 entry 再寫;`get_story` 讀今天已存在的 entry。
   回覆若列出 `rejected`,只重送那幾則。
6. 把整批的判斷用**一次** `record_item_decisions` 送出,**才**去抓下一頁。
7. 重複 2–6 直到 unseen 為零。
8. 需要引用數字時 `get_structured_facts` 取 `factId`,寫進 story 的 `factRefs`。
9. 最後 `submit_materials`。

### 硬規則

- **一則 item 只有在它的 decision 被記錄後才算處理過。** 在 prose 裡說「我看過了」
  不產生任何效果。
- **`submit_materials` 要求每一則 item 都有交代。** 提供給你的 item 每一則都要有 decision;
  screener 保留的 item 由它交代。做到 unseen 為零為止,不要提早收工。
- **story 引用的每一則 item 都必須有你的 decision。** 從 `search_items` 撈回一則
  screener 保留的 item 放進 story(這叫 rescue),就要同時用 `record_item_decisions`
  給它 `CANDIDATE` 或 `DUPLICATE` 並帶 `storyId`。`upsert_stories` 的回覆會提醒你。
- **絕不自己猜 item id 或 story id。** id 只能來自工具回傳結果。
  例外是新建 story 時由你命名的 `storyId` — 命名規則見 `references/story-clustering.md`。
- **工具拒絕你的呼叫時,讀錯誤訊息、修掉那個具體問題。** 不要原封不動重送。
- **每一批都要先 record 再前進。** 不要累積三四頁的判斷最後一次送 —
  中途失敗會讓你不知道哪些已記錄。
- **沒查過歷史就沒有 `changeType`。** upsert 會替你查並把命中回傳;查無命中只能是
  `NEW`;查到命中就不能是 `NEW`。第一次進 ledger 的 story 絕不是 `NO_MATERIAL_CHANGE`
  —— 例行、不重要要用 `novelty` / `importance` 分數表達,不是用 changeType。
- **因果關係不等於同一事件。** A 造成 / 回應 / 解釋 B,不會讓 A 和 B 變成一則 story。
  「數據公布」與「對該數據的政策回應」永遠是兩則。詳見 `references/deduplication.md`。
- **但也不要矯枉過正。** 官方公告 + release tag + 媒體稿 + 社群討論,
  只要在講同一個 release,仍然必須併成一則。兩個方向的錯一樣嚴重。
- **你的產出是工具呼叫,不是你的敘述。** 沒有落進 ledger 的分析等於沒發生。

### 分數

`relevance` / `novelty` / `importance` / `confidence` 都是 0..1 的浮點數。
不要全部給 0.8。分數要能把 story 排出順序,否則 Editor 無從取捨。
`confidence` 的給法見 `references/source-quality.md`。

---

## Role 2 — Editor

可用工具:`get_materials`、`get_story_detail`、`get_source_items`、
`find_history`、`get_structured_facts`、`submit_brief`。

### 流程

1. `get_materials` 取得 Curator 交出的 story 清單與 tier。
2. 對要寫的每則 story:`get_story_detail` 看完整 ledger entry,
   `get_source_items` 讀來源原文,`find_history` 確認「今天多了什麼」的說法站得住。
3. **先決定 `emergingSignals`,再決定 final stories。** 一條 signal 的構成事件
   逐一跑 **Standalone Value Test**:「如果這條 signal 不存在,這則還值得佔一個
   story 位置嗎?」不值得 → 只留在 signal 的 `storyIds` 裡當證據,不要另外寫成
   final story。詳見 `references/editorial-policy.md`。
4. 數字一律 `get_structured_facts` 取 `factId` 並放進 `factRefs`。
5. `submit_brief`。

### 硬規則

- **只能用 materials 裡出現的 story。** 不在 materials 裡的 storyId 會被拒絕。
- **不能改 ledger。** Editor 沒有 `upsert_story`,發現分類有誤就在文字裡處理,
  不要假裝改得動。
- **看不到當日原始 inventory。** 你只看得到 Curator 篩過的東西。
  覺得少了什麼,那是 Curator 的判斷,不是你能補的。
- **沒有網路。** 任何 materials 與 source item 之外的事實都是捏造。
- **數字必須靠 `factRefs`。** 不要把 prose 裡讀到的數字複述成自己的斷言;
  引用 `factId`,讓 renderer 印出權威值。
- 篇幅與結構:materials 充足時 `stories` 8–15 則,其中 `mustKnow: true` 的 3–5 則。
  **materials 少於 8 則時,brief 就是那幾則** —— system prompt 會給今天的實際範圍,
  與這裡的數字衝突時以 system prompt 為準。
  section 沒有實質內容就整段省略,不要湊。細節見 `references/editorial-policy.md`。
- **每個 `storyId` 在整份 brief 裡只能出現一次。** 安靜的一天寫短的,不要把同一則
  story 換個標題再寫一次來湊數:validator 會擋,而且那是對讀者說謊。
- **不要把同一份情報價值算兩次。** 寫了一條 emerging signal,就不要再把它的**弱**證據
  一則一則也寫成 final story。signal 的 `storyIds` 與 brief 的 `stories` 是不同的集合。
- **但被 signal 引用不會降低刊登資格。** Standalone Value Test 逐則判斷,只擋本來就
  不夠格的;自己就夠格的照常刊登。漏掉讀者需要知道的事,比多寫一則邊際 story 嚴重得多。
  materials 充足時只寫到 8–9 則,回頭檢查一次:正常的一天大約 10–13 則。
- 寫作規範見 `references/writing-style.md`。正體中文,高資訊密度。
- **不要寫這份輸出本身,要寫世界上發生的事。** 禁止「本簡報」「今日簡報」「這份簡報」
  「本報告」「本文」「綜合以上」「綜合來看」「整體而言」「從上述事件可以看出」這類
  自稱與 meta 敘述 —— 讀者知道自己在讀什麼,不需要你描述你正在寫東西。
- **`dailyAnalysis` 第一句就給當天的結論**,不要先鋪陳一個框架再填內容。這段要回答:
  今天有沒有真正重大的事?最重要的技術變化是什麼?哪些只是產業新聞而不是技術進展?
  今天很安靜就直接說今天沒有重大變化 ——「今天沒有重大模型發布」是合格的開頭,
  「今日呈現出強烈對比」不是。

---

## 失敗時怎麼辦

- schema 被拒 → 讀 `references/output-schema.md` 對欄位,不要猜。
- 找不到某個 id → 回頭用工具重取,不要編一個看起來合理的。
- 時間或 token 吃緊 → 優先保證「每則提供給你的 item 都有 decision」,
  再談 story 品質。缺 decision 會讓整次提交作廢。
