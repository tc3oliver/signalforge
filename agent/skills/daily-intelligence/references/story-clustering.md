# Story Clustering — storyId、主來源、拆與併

## storyId:跨日必須穩定

`storyId` 是這個 story 在 ledger 裡的永久鍵。明天同一件事再有新進展時,
明天的 Curator 會用 `find_history` 去找它 — **找得到的前提是 id 一樣**。

所以 `storyId` 命名的唯一目標是:**一個理性的人,在只知道事件本身的情況下,
明天會取出同一個字串。**

### 規則

- 小寫、連字號分隔的 slug。只用 `a-z`、`0-9`、`-`。
- 結構:`<主體>-<事件核心>[-<辨識子>]`
- **不放日期。** `openai-api-outage-2026-09-13` 明天就對不上了。
  日期由 ledger 的 `date` / `firstSeenAt` / `lastSeenAt` 負責。
- **不放今天的措辭。** 不要 `openai-shocks-industry`。今天的形容詞明天不會重現。
- **不放 changeType。** 不要 `-rumor` 或 `-confirmed`;那是欄位不是身分。
- 用事件的**穩定核心**命名:涉及的組織、產品、事件類型。
- 長度控制在 3–6 個 token。太短會撞名,太長不穩定。

### 例子

| 事件 | 好的 storyId | 壞的,以及為什麼 |
|---|---|---|
| Anthropic 發布 Claude 新版本 | `anthropic-claude-model-release` | `claude-is-here`(措辭)、`anthropic-0913`(日期) |
| 某雲端商區域性中斷 | `cloudprovider-eu-region-outage` | `major-outage`(誰的?撞名) |
| 某開源專案改授權 | `redis-license-change` | `oss-drama`(不可重現) |
| CVE 事件 | `openssl-cve-2026-1234` | `critical-vuln`(撞名) |
| 監管調查 | `eu-antitrust-probe-bigco` | `regulators-move`(太泛) |

CVE 編號、法案編號、repo 全名這類天然穩定鍵,**直接放進 slug**,是最好的選擇。

### 新建之後看回覆

`commit_curation_batch` 會用你給的 slug、再用 canonicalTitle 查昨天以前的 ledger,
命中放在回覆的 `history`。
- 命中且確實是同一事件 → 用舊 storyId 重新 upsert,這是 UPDATE 系列,不是 NEW。
- 命中但其實是不同事件 → 換一個更具辨識度的 slug(加上產品名或編號)重送。
- 沒命中但你懷疑只是拼法不同 → 自己 `find_history` 用主要實體名再查一次。

這第二次查很重要:漏掉歷史會讓你把 UPDATE 誤記成 NEW。

---

## primarySourceIds:權威來源,不是最大聲的那個

`primarySourceIds` 回答「這件事的事實以誰為準」。

### 排序原則

1. **事件的發起方**。公司的公告、專案的 release、機關的正式文件、
   作者本人的論文頁。事件是他們造成的,他們的說法定義事實。
2. 若沒有發起方 item,取**最接近一手**的:當事人的訪談、當事工程師的 post-mortem。
3. 再不然取**有獨立查證的技術媒體**報導。
4. **聚合討論(HN / Reddit)幾乎不該是 primary**,除非事件本身就發生在那裡
   (例如爭議本身是一則 HN 貼文引爆的),或它是唯一的資訊來源。

### 常見錯誤

- 把媒體改寫稿當 primary,因為它寫得比較完整。**不行** — 完整不等於權威。
- 把 HN 討論串當 primary,因為它 comment 最多。**不行** — 熱度不等於權威。
- 把全部 item 都塞進 primarySourceIds。**不行** — 那等於沒有指認。
  多數 story 的 primary 是 1 個,偶爾 2 個(例如兩家公司共同發布)。

`sourceItemIds` 是**全部**成員(含 primary);`primarySourceIds` 是其中的權威子集,
必須是 `sourceItemIds` 的子集,且至少 1 個。

---

## 何時拆、何時併

### 拆(一個 cluster → 多個 story)

- 同一 cluster 裡出現**兩條獨立的時間線**:發布本身、以及發布後衍生的漏洞/爭議。
- 成員 item 的因果主張互相不相容(不是矛盾報導,是在講不同事)。
- cluster 的 `canonicalTitle` 寫不出一句話 — 要用「以及」才寫得完,通常代表該拆。

拆的時候:兩個 story 各有自己的 storyId,重疊的 item 歸給主要那則,
在兩則的 `reason` 裡各自點名對方。

### 併(多個 cluster → 一個 story)

- 兩個 cluster 的 primary 其實互相引用。
- 兩個 cluster 描述的是同一事件的「宣布」與「細節」。
- 你發現自己對兩個 cluster 寫出了幾乎一樣的 `reason`。

併的時候:選一個更穩定的 storyId(通常是較早建立、或命名較準的那個),
在一次 `commit_curation_batch` 裡把兩邊的 `sourceItemIds` 合併、重新指定
`primarySourceIds`,並把原本指向被併 storyId 的 decision 一併更新。

### 併之前必須通過 Event Identity Test

`deduplication.md` 的 **Event Identity Test** 是合併的前置條件,不是參考意見。
五題有任何一題答「否」,尤其是:

> 「其中一件事,可以合理地在另一件事不存在的情況下發生嗎?」

答「可以」 → **不要併**。

最常見的誤併是**因果誤併**:A 引發 B、B 回應 A,於是把兩者當成一件事。
因果關係只說明兩件事相關,不說明它們是同一件事。
典型形狀是「某個發生(occurrence)」加上「某個對它的決定(decision)」 —
decision 與 occurrence 幾乎永遠是兩則 story。

判斷輔助:如果你要為合併後的 cluster 指定 `primarySourceIds`,
卻發現必須放進**兩個不同機構各自的一手文件**才說得完整,
那就是兩件事被併在一起了。一則 story 的權威來源應該指向同一個發起方。

### 但不要矯枉過正

修正誤併的方向不是「什麼都不併」。

官方公告、GitHub release、媒體報導、社群討論,只要明確在描述**同一個 release
或同一個 occurrence**,就**仍然必須**併成一則 story。那是 Curator 的主要工作,
也是 `deduplication.md` 開頭那句話的意思:一篇文章不是一則 story。

兩個方向的錯誤同樣嚴重:

| 錯誤 | 徵兆 |
|---|---|
| 過度合併 | 一則 story 的 `canonicalTitle` 要用「以及」才寫得完;primary 來自兩個不同機構;changeType 難以指定 |
| 過度拆分 | story 數量接近 item 數量;同一個版本號出現在多則 story;多則 story 的 `reason` 幾乎一樣 |

Event Identity Test 的五題**全部**答「是」→ 併。有一題答「否」→ 拆。
不確定時,回去比對 `deduplication.md` 的六個面向,不要靠直覺。

### 判準

問一句話:**「明天如果只有這件事有新進展,我會希望它是一筆獨立的歷史紀錄嗎?」**
會 → 拆。不會 → 併。

## cluster 大小的直覺

- 1 則 item 的 story 很正常(冷門但重要的官方公告)。不要因為只有一個來源就不成案。
- 10 則以上的 cluster 要警覺:多半混進了不同事件,回頭用 `deduplication.md` 的訊號重驗。
- 一天的 CANDIDATE cluster 數量通常遠少於 item 數量。
  如果你的 story 數量接近 item 數量,幾乎確定去重做得不夠。
