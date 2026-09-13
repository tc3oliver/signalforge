# Deduplication — 一篇文章不是一則 story

**核心區分:item 是報導,story 是現實世界發生的事。**
一件事會同時出現在官方 blog、GitHub release、HN 討論串、Reddit 抱怨文、
科技媒體改寫稿、YouTube 影片、arXiv 論文頁。那是 **1 則 story、7 則 item**,
不是 7 則 story。

Curator 最容易犯的錯,是把「今天有幾篇文章」當成「今天有幾件事」。

## 三種關係:SAME_EVENT / RELATED_EVENT / BACKGROUND_CONTEXT

先把關係分類,再決定要不要併。這三類的處置方式完全不同。

### `SAME_EVENT` → 全部歸到同一個 `storyId`
描述的是**同一個真實世界發生的事**。主來源之外的其他 item 記為 `DUPLICATE`,
並帶上同一個 `storyId`。

### `RELATED_EVENT` → 不同 storyId,在 `reason` 或 brief 裡建立關聯
兩件**不同**的事,但彼此有因果、回應或同屬一條敘事線。
判準:如果拿掉 A,B 仍然獨立成立,就是兩件事。

主體相同也不代表同一事件:「某公司發新模型」與「某公司更新使用條款」
是兩件各自成案的事,即使同一天、同一家公司。

### `BACKGROUND_CONTEXT` → 不建立今天的新 event
解釋性、回顧性、分析性的材料,講的是**既有的長期狀態或更早發生的事**,
今天沒有新的 occurrence。

處置:附到它所解釋的那則 story(`DUPLICATE`,同 `storyId`),或記為 `IRRELEVANT`。
**不要**因為今天出現一篇分析文,就替一個沒有新進展的主題開一則新 story —
那會製造出當天並未真的發生的事件,並污染 ledger 的 changeType 判斷。

---

## 因果關係不等於事件同一性

這是 macro 與政策報導最常見的併錯方向。

> **A 造成、影響、解釋或觸發了 B,不會讓 A 和 B 變成同一件事。**

「數據公布」與「央行對該數據的政策回應」是兩則 story,不是一則。
它們因果相連、同屬一條 macro 敘事、發生在同一個新聞週期 —
但發起方不同、核心動作不同、權威來源不同。

合併之前,逐項比對這六個面向:

| 面向 | 問題 |
|---|---|
| **Principal Actor** | 誰做的?是同一個主體嗎? |
| **Core Action** | 核心動作或決定是什麼?實質上是同一個嗎? |
| **Object / Subject** | 動作施加在什麼對象上? |
| **Decision or occurrence** | 這是一個決定,還是一個發生?兩者不是同一種事件。 |
| **Time** | 指涉的事發時間(不是 publishedAt)是同一個時點嗎? |
| **Primary Source** | 同一份一手證據能同時確立這兩件事嗎? |

### Event Identity Test

把兩則 item 併進同一個 Story 之前,問這五題:

1. 它們描述的是**同一個真實世界的 occurrence** 嗎?
2. **Principal actor** 實質上相同嗎?
3. **核心動作或決定**實質上相同嗎?
4. **同一份 primary-source 證據**能同時確立這兩件事嗎?
5. 其中一件事,**可以合理地在另一件事不存在的情況下發生**嗎?

第 5 題答「可以」,幾乎就確定是兩件事。

**不要僅僅因為下列理由就合併:**

- 一件事造成了另一件事;
- 一件事是對另一件事的回應;
- 兩者屬於同一條敘事線;
- 兩者發生在同一個新聞週期。

---

## Worked examples

### SAME_EVENT — 同一個 release 的多重報導

```
官方 release 公告
+ GitHub release tag(同一版本號)
+ 科技媒體的報導稿
+ 社群討論串(明確在討論那個 release)
```

→ **1 則 story**,4 則 item,primary 是官方公告。

Principal actor 同、core action 同(發布該版本)、時間同、
同一份 release note 就能確立全部四則所講的事。全數通過 Event Identity Test。

**這種情況仍然必須合併。** 分開會製造重複,是另一個方向的錯誤。

### RELATED_EVENT — 數據公布 → 政策回應

```
統計機關公布通膨數據
央行其後改變或說明政策,部分是對該數據的回應
```

→ **2 則 story**:

| | Story A | Story B |
|---|---|---|
| Principal actor | 統計機關 | 央行 |
| Core action | 公布一組統計數字 | 做出並宣布一項政策決定 |
| 類型 | occurrence | decision |
| Primary source | 統計發布 | 央行聲明 / 會後記者會 |

關係:**A influences B**。寫在兩則的 `reason` 裡互相點名,
並且讓 brief 在文字上把因果講清楚 — 但它們是兩筆獨立的歷史紀錄。

明天如果央行改口而數據沒有修正,你會希望那是 Story B 的 UPDATE,
而不是把一則混合 story 的 changeType 弄得無法判斷。這就是拆開的實際理由。

### BACKGROUND_CONTEXT — 解釋長期趨勢的舊分析

```
一篇解釋該通膨長期走勢成因的分析文章
```

→ **不建立今天的新 event**。

它沒有新的 occurrence,只是在解釋既有狀態。
附到它所解釋的那則 story,或記 `IRRELEVANT`。
把它開成新 story 會讓 ledger 出現一件今天並未發生的事。

---

---

## 標題相似度是很弱的訊號 — 兩個方向都會騙人

### 方向一:同一事件,標題完全不像

這是最常漏掉的情況。同一個事件的六則 item 可能長這樣:

| 來源 | 標題 |
|---|---|
| 官方 blog | `Introducing Structured Outputs in the API` |
| github | `v2.14.0 — add response_format=json_schema` |
| hackernews | `Show HN: I replaced my whole parsing layer today` |
| reddit | `Finally. No more regex hell.` |
| web(媒體) | `這家公司悄悄解決了開發者最頭痛的問題` |
| youtube | `我用 30 分鐘重寫了整個後端` |

字面重疊幾乎是零。但它們是同一件事。

### 方向二:不同事件,標題幾乎一樣

- `Meta releases Llama 4` vs `Meta releases Llama 4 Scout weights on HuggingFace`
  — 若後者是三週後的權重釋出,是**不同事件**(UPDATE 或新 story,看性質)。
- 兩家不同公司同日發布同類型產品,標題都是 `X launches open-weight coding model`
  — **兩件事**。
- 同一個 CVE 編號在兩個不同套件被提及 — **兩件事**。

**結論:不要用字串相似度決定去重。**

---

## 該用的訊號

依可靠度由高到低:

1. **具名實體的交集**:公司、產品、人名、repo 名、CVE 編號、法案編號、
   交易所/機關名稱。三個以上具名實體重疊,強烈指向同一事件。
2. **版本號 / 型號**:`v2.14.0`、`Llama 4 Scout`、`CVE-2026-1234`。
   精確到 patch 版本的重疊幾乎確定同一事件;只有 major 版本相同則不足。
3. **被指涉的日期**:內文提到的事發時間(不是 publishedAt)。
   兩則都在講「上週四的中斷」→ 同一事件;一則講今天、一則講三個月前 → 不同。
4. **提出的因果主張**:「因為 X 所以 Y」。同一事件的報導,
   即使措辭不同,因果骨架會一致。骨架不同通常代表不同事件。
5. **互相引用**:一則 item 的內文或 url 指向另一則(HN 討論串指向官方 blog、
   媒體稿引用 GitHub release)。這是最乾淨的證據 — **有互引就是同一事件**。
6. **數字吻合**:同樣的金額、同樣的 benchmark 分數、同樣的使用者數。

## 操作流程

1. 拿到一則疑似成案的 item,抽出它的具名實體與版本號。
2. 用 `search_items` 以那些實體/版本號查詢,**不要用標題整句去查**。
   分開查「公司名」和「產品名」,兩次查詢的交集才是候選。
3. 對候選逐一比對上面 6 個訊號。兩個以上獨立訊號吻合 → 同一事件。
4. 不確定時,對最關鍵的那一兩則呼叫 `get_item_detail` 看內文有沒有互引。
5. 確定後:選出主來源(見 `story-clustering.md`),
   `upsert_story` 帶上全部 `sourceItemIds`,其餘 item 記 `DUPLICATE` + 同一 `storyId`。

## 邊界情況

- **同一公司同日兩個公告**:分開,除非其中一個只是另一個的附註。
- **一則 item 講了三件事**(週報、彙整文):歸到其中最主要的 story,
  或若三件都已各自成案,歸到最重要的一則並在 reason 註明。不要為它另開 story。
- **Reddit / HN 上的抱怨潮**:如果抱怨對象是某個已成案的事件,是 `DUPLICATE`;
  如果抱怨本身揭露了官方尚未承認的問題,那是**獨立事件**(且 `changeType` 多半是 `RUMOR`)。
- **論文與其媒體報導**:同一事件,主來源是 arXiv / semantic-scholar 那則。
