# Novelty 與 changeType

## Novelty 回答的問題

> **今天讓我們知道了昨天不知道的什麼?**

它**不是**「今天有沒有新文章」。新文章每天都有。
一件事被重新報導二十次,知識沒有增加,novelty 就是低的。

先拿到這個 story 昨天以前的狀態(`upsert_stories` / `upsert_story` 會替你查,
命中隨回覆的 `history` 回來;要先讀舊 entry 就自己呼叫 `find_history`),再問:
**把今天的 item 拿掉,我對這件事的理解會少掉什麼?**

- 少掉一個具體事實 → 高 novelty。
- 少掉的只是「又有人談論它」→ 低 novelty,`NO_MATERIAL_CHANGE`。

---

## 先決條件:沒查過歷史就不能給 changeType

`changeType` 是**今天相對於 ledger** 的判斷,所以它在邏輯上依賴歷史查詢的結果。
沒有查過歷史就填的 changeType 是猜的,而猜錯會污染明天的判斷 —— 明天的 Curator
會把你今天的錯誤當成事實。

查歷史的動作由工具替你做:每一次 `upsert_stories` / `upsert_story` 都會先用 storyId、
再用標題去查昨天以前的 ledger,把命中放進回覆的 `history`。所以流程是:

```
upsert(changeType 你的判斷)  →  讀回覆的 history  →  有命中且是同一條線?→  用舊 storyId 重新 upsert
```

工具同時執行下面第一條規則:非 `NEW` 卻查無歷史,直接拒絕。
拿不準、想先讀舊 entry 再決定的,呼叫 `find_history`。

### 兩條硬規則

**1. `find_history` 沒有命中 → 只能是 `NEW`。**

沒有歷史就不存在「變化」。一個 ledger 裡不存在的 story 不可能是 `UPDATE`、
`ESCALATION`、`CONFIRMATION` 或 `NO_MATERIAL_CHANGE` —— 那些全部預設了一個更早的狀態。

尤其:**第一次出現的 story 絕對不是 `NO_MATERIAL_CHANGE`。**
「例行、不重要、每週都有」不等於「沒有變化」。一則每週都會發布的數據,
今天第一次進 ledger 就是 `NEW`,只是它的 `novelty` 分數低而已。
重要性低用分數表達,不要用 changeType 表達 —— 那是兩個不同的欄位。

**2. `find_history` 有命中 → 不能是 `NEW`。**

找到了就沿用那個 storyId,並從其餘七種裡選。把有歷史的 story 記成 `NEW`
會把一條追蹤中的線斷成兩截,ledger 就失去它唯一的用處。

### 批次作業時特別容易錯

`upsert_stories` 一次寫一整頁的 story,回覆裡每一則各自帶自己的 `history`。
**一則一則做完整循環**是指:對回覆裡的**每一則**都讀它的 history 再定案,
不要掃過去只看第一則。有命中卻標 `NEW` 的,當場用舊 storyId 重送那一則;
不要把「建 story」和「看歷史」拆成兩個階段,更不要留到最後回頭補。

---

## 八種 changeType

### `NEW`
這個 story 之前不存在於 ledger。upsert 回覆沒有 `history`
(工具已用 storyId 和標題各查過一次),或你自己 `find_history` 確認過。

> 例:某公司今天首次公告將於 Q4 開放某 API。ledger 裡沒有任何相關 story。

注意:**一件事在現實中已存在很久,但我們第一次追蹤它,仍然是 `NEW`。**
`NEW` 描述 ledger 的狀態,不是世界的狀態。

### `UPDATE`
story 已存在,今天增加了實質但不改變方向的資訊。

> 例:昨天 `cloudprovider-eu-region-outage` 記錄「歐洲區中斷、原因不明」。
> 今天官方 post-mortem 出爐:BGP 設定錯誤,影響 4 小時 12 分。
> 方向沒變(還是那場中斷),但我們多知道了原因和精確範圍 → `UPDATE`。

### `ESCALATION`
規模、嚴重性或影響範圍**擴大**。

> 例:昨天記錄「某套件發現漏洞,影響 1 個版本分支」。
> 今天發現同一漏洞影響全部 3.x 版本,且已有實際被利用的案例 → `ESCALATION`。

判準:讀者昨天的應對如果是「留意」,今天要升級成「立刻處理」,就是 ESCALATION。

### `RESOLUTION`
事情**結束**了。修復完成、服務恢復、訴訟和解、收購完成、爭議落幕。
同時應把 `status` 設為 `RESOLVED`。

> 例:`cloudprovider-eu-region-outage` 今天官方宣告全區服務恢復、
> 補償方案公布 → `RESOLUTION`,`status: RESOLVED`。

### `REVERSAL`
先前成立的事實或決定**被推翻**。方向反轉,不只是修正細節。

> 例:上週記錄「某開源專案將改為商業授權」。今天在社群壓力下,
> 維護者宣布撤回授權變更、維持原授權 → `REVERSAL`。

> 例:先前報導「A 公司將收購 B」,今天 A 公司正式否認並終止談判 → `REVERSAL`。

`REVERSAL` 不是 `RESOLUTION`:結束是走到終點,反轉是掉頭。

### `CONFIRMATION`
先前是傳聞、推測、未具名消息來源的事,今天由**當事方或權威來源證實**。

> 例:三天前 `bigco-layoffs` 記為 `RUMOR`(來源是匿名論壇貼文)。
> 今天公司發出正式聲明確認裁員規模 → `CONFIRMATION`。

**這不是 `NEW`。** 即使今天的官方公告是這個 story 第一次有權威來源,
story 本身已存在於 ledger,所以是 `CONFIRMATION`。
把它記成 `NEW` 會丟失「我們三天前就知道了」這條歷史,那正是 ledger 的價值所在。

`CONFIRMATION` 通常伴隨 `confidence` 大幅上升。

### `RUMOR`
今天出現的資訊來自非權威來源、未經證實、或當事方尚未回應。

> 例:Reddit 上有自稱員工的帳號說某產品線將被砍,無其他佐證 → `RUMOR`,
> `confidence` 低(0.2–0.4),`status: OPEN`。

`RUMOR` 可以套用在新建的 story(該 story 本身就是從傳聞開始的)。
之後若被證實 → `CONFIRMATION`;若被否認 → `REVERSAL`。

### `NO_MATERIAL_CHANGE`
今天有新的報導,但**沒有新的事實**。

> 例:上週某公司發布新模型,已記入 ledger。今天有五篇媒體評論文、
> 兩支 YouTube 開箱、一串 Reddit 討論,全部在講同一個已知的發布。
> 沒有新數據、沒有官方補充、沒有新的第三方驗證 → `NO_MATERIAL_CHANGE`。

**一波新的報導潮不等於新的事實。** 這是最常被誤判成 `UPDATE` 的情況。
熱度是傳播現象,不是資訊增量。

`NO_MATERIAL_CHANGE` 的 `novelty` 應該很低(0.0–0.15)。
這種 story 通常不該進入最終簡報,除非它有其他理由(見 `editorial-policy.md`)。

判斷竅門:你能不能寫出一句「今天新增的是 ___」而不重複昨天已知的內容?
寫不出來 → `NO_MATERIAL_CHANGE`。

---

## novelty 分數

`changeType` 與 `novelty` 要一致:

| changeType | 典型 novelty |
|---|---|
| `NEW` | 0.7 – 1.0 |
| `ESCALATION` / `REVERSAL` | 0.6 – 0.9 |
| `CONFIRMATION` / `RESOLUTION` | 0.5 – 0.8 |
| `UPDATE` | 0.3 – 0.6 |
| `RUMOR` | 0.3 – 0.6(視傳聞的資訊量) |
| `NO_MATERIAL_CHANGE` | 0.0 – 0.15 |

這是區間不是查表:一個微不足道的 `NEW`(小專案發了個小版本)可以是 0.5;
一個推翻整個產業預期的 `UPDATE` 可以是 0.7。用判斷,但不要跟 changeType 打架。

## novelty 與 importance 是兩回事

- 高 novelty、低 importance:某冷門專案首次發布。真的新,但沒人在乎。
- 低 novelty、高 importance:一個持續延燒的重大中斷,今天沒有新進展,
  但讀者仍需要知道它還沒結束。

兩個分數分開給,不要讓其中一個污染另一個。
