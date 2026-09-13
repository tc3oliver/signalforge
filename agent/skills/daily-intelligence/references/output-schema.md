# Output Schema

Field-by-field shape of every payload you submit. All objects are **strict**:
an unknown field is a parse failure, not a warning. Do not add fields that are
not listed here. Do not omit required fields.

All scores (`relevance`, `novelty`, `importance`, `confidence`) are **floats in
`0..1` inclusive**. Not percentages, not integers, not strings. `0.85`, not `85`.

Timestamps (`decidedAt`, `date`, `producedAt`, `firstSeenAt`, `lastSeenAt`) are
stamped **server-side**. Never send them.

---

## Enum values (verbatim — exact case, exact spelling)

```
Disposition:   IRRELEVANT | DUPLICATE | CANDIDATE

ChangeType:    NEW | UPDATE | ESCALATION | RESOLUTION
               REVERSAL | CONFIRMATION | RUMOR | NO_MATERIAL_CHANGE

StoryStatus:   OPEN | RESOLVED | DORMANT

MaterialTier:  A | B | C

BriefSection:  MUST_KNOW | AI_LLM | DEVELOPER_OSS | RESEARCH
               CRYPTO_MARKET | MACRO | COMPANIES

ConfidenceLevel: HIGH | MEDIUM | LOW
```

`StoryStatus` 用法:`OPEN` 事情還在進行;`RESOLVED` 已結案
(搭配 `changeType: RESOLUTION`);`DORMANT` 沒結案但已無進展,暫時擱置。

---

## 1. `record_item_decisions`

送出一整批(一頁 `list_unseen_items` 的全部)的 decision。

每筆 decision:

| Field | Type | Required | Notes |
|---|---|---|---|
| `itemId` | string, non-empty | yes | 只能來自工具回傳。不可自造 |
| `disposition` | Disposition enum | yes | |
| `storyId` | string, non-empty | optional | `CANDIDATE` 與 `DUPLICATE` 必填;`IRRELEVANT` 省略 |
| `reason` | string, non-empty | yes | 一句具體理由,不是分類標籤的重複 |

`decidedAt` 由 server 加上,**不要送**。

```json
{
  "decisions": [
    {
      "itemId": "itm_0f3a91",
      "disposition": "CANDIDATE",
      "storyId": "redis-license-change",
      "reason": "維護者正式公告授權變更,含生效日與既有版本處置"
    },
    {
      "itemId": "itm_0f3a92",
      "disposition": "DUPLICATE",
      "storyId": "redis-license-change",
      "reason": "HN 討論串,指向同一則官方公告,無新增事實"
    },
    {
      "itemId": "itm_0f3a93",
      "disposition": "IRRELEVANT",
      "reason": "消費性手機發表會報導,無技術或決策影響"
    }
  ]
}
```

---

## 2. `upsert_story`

建立或更新 ledger 中的一則 story。同一個 `storyId` 再次 upsert 即為更新。

| Field | Type | Required | Notes |
|---|---|---|---|
| `storyId` | string, non-empty | yes | 跨日穩定的 slug,見 `story-clustering.md` |
| `canonicalTitle` | string, non-empty | yes | 事件本身的描述,不是某篇報導的標題 |
| `sourceItemIds` | string[], **min 1** | yes | 這則 story 的全部成員 item |
| `primarySourceIds` | string[], **min 1** | yes | 必須是 `sourceItemIds` 的子集 |
| `status` | StoryStatus | yes | |
| `changeType` | ChangeType | yes | 先 `find_history` 再決定 |
| `relevance` | float 0..1 | yes | 對目標讀者的相關度 |
| `novelty` | float 0..1 | yes | 今天新增了多少昨天沒有的資訊 |
| `importance` | float 0..1 | yes | 後果的量級 |
| `confidence` | float 0..1 | yes | 事實成立的機率,見 `source-quality.md` |
| `reason` | string, non-empty | yes | 為何這樣分類與評分 |
| `factRefs` | string[] | optional, default `[]` | `get_structured_facts` 回傳的 factId |

`date` / `firstSeenAt` / `lastSeenAt` 由 server 管理,**不要送**。

```json
{
  "storyId": "redis-license-change",
  "canonicalTitle": "Redis 改採 SSPL 授權,11 月 1 日起的新版本適用",
  "sourceItemIds": ["itm_0f3a91", "itm_0f3a92", "itm_0f3a9e", "itm_0f3ab4"],
  "primarySourceIds": ["itm_0f3a91"],
  "status": "OPEN",
  "changeType": "NEW",
  "relevance": 0.88,
  "novelty": 0.82,
  "importance": 0.79,
  "confidence": 0.95,
  "reason": "維護者官方公告,條款與生效日明確。影響所有將此套件包進商業服務的使用者。primary 取官方 blog,其餘三則為轉述與討論。",
  "factRefs": []
}
```

---

## 3. `submit_materials`

Curator 的最終交件。**在 manifest 還有 item 沒有 decision 時會被拒絕。**

Top level:

| Field | Type | Required | Notes |
|---|---|---|---|
| `stories` | DailyMaterialStory[], **min 1** | yes | 見下表 |
| `emergingSignals` | object[] | optional, default `[]` | 0–3 條,見 `emerging-signals.md` |
| `curatorNotes` | string | optional, default `""` | 給 Editor 的取捨說明 |

每則 `stories[]`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `storyId` | string, non-empty | yes | 必須已 `upsert_story` 存在於 ledger |
| `tier` | `A` \| `B` \| `C` | yes | |
| `canonicalTitle` | string, non-empty | yes | |
| `whySelected` | string, non-empty | yes | 為何值得 Editor 考慮 |
| `changeType` | ChangeType | yes | 與 ledger 一致 |
| `importance` | float 0..1 | yes | |
| `novelty` | float 0..1 | yes | |
| `confidence` | float 0..1 | yes | |
| `sourceItemIds` | string[], **min 1** | yes | |
| `primarySourceIds` | string[], **min 1** | yes | |
| `factRefs` | string[] | optional, default `[]` | |

每條 `emergingSignals[]`:`label`(non-empty)、`rationale`(non-empty)、
`storyIds`(string[],每個 non-empty)。不接受其他欄位。

**注意 `relevance` 與 `status` 不在 materials 的欄位裡** — 送了會被拒。

交件的 story 數量要足夠讓 Editor 選出 8–15 則 brief story,
所以 materials 至少要有 12 則以上可用的 A/B story 才安全。

```json
{
  "stories": [
    {
      "storyId": "redis-license-change",
      "tier": "A",
      "canonicalTitle": "Redis 改採 SSPL 授權,11 月 1 日起的新版本適用",
      "whySelected": "直接影響所有把此套件包進商業服務的團隊,有明確生效日,需要在期限前決定續用或遷移",
      "changeType": "NEW",
      "importance": 0.79,
      "novelty": 0.82,
      "confidence": 0.95,
      "sourceItemIds": ["itm_0f3a91", "itm_0f3a92", "itm_0f3a9e", "itm_0f3ab4"],
      "primarySourceIds": ["itm_0f3a91"],
      "factRefs": []
    }
  ],
  "emergingSignals": [
    {
      "label": "基礎設施專案的授權收緊",
      "rationale": "本週第三個獨立的基礎設施專案調整授權條款,三者分屬不同公司與不同領域,共同壓力來自雲端商的免費轉售。若為巧合,後續數週應不再出現同類動作。",
      "storyIds": ["redis-license-change", "otherproj-license-change", "thirdproj-relicense"]
    }
  ],
  "curatorNotes": "今日 A 級三則皆有明確行動期限。CRYPTO_MARKET 類今日僅有例行波動,未成案。"
}
```

---

## 4. `submit_brief`

Editor 的最終交件。

Top level:

| Field | Type | Required | Notes |
|---|---|---|---|
| `stories` | DailyBriefStory[], **min 8, max 15** | yes | 少於 8 或多於 15 直接拒絕 |
| `emergingSignals` | object[] | optional, default `[]` | `label` / `body` / `storyIds` |
| `dailyAnalysis` | string, non-empty | yes | |
| `watchNext` | string[], **min 1**, each non-empty | yes | |

每則 `stories[]`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `storyId` | string, non-empty | yes | 必須出現在 `get_materials` 的結果中 |
| `section` | BriefSection | yes | 一則只有一個 section |
| `mustKnow` | boolean | yes | **恰好 3–5 則為 `true`** |
| `title` | string, non-empty | yes | |
| `whatHappened` | string, non-empty | yes | |
| `whyItMatters` | string, non-empty | yes | |
| `whatChanged` | string, non-empty | yes | |
| `impact` | string, non-empty | yes | |
| `confidence` | ConfidenceLevel | yes | `HIGH` / `MEDIUM` / `LOW`,**不是數字** |
| `sourceItemIds` | string[], **min 1** | yes | |
| `factRefs` | string[] | optional, default `[]` | |

`emergingSignals[]` 在 brief 用的欄位是 **`body`**(不是 materials 的 `rationale`):
`label`(non-empty)、`body`(non-empty)、`storyIds`(string[])。

**`storyIds` 只需要存在於當日 materials,不需要同時是 brief 的 final story。**
這是刻意的:signal 的構成事件多半個別太弱、不該佔用 story 位置,
那正是這條 signal 值得寫的原因。把它們留在 `storyIds` 裡當證據即可。
判準見 `editorial-policy.md` 的 Standalone Value Test。

### 數值 confidence → ConfidenceLevel 對照

| ledger `confidence` | brief `confidence` |
|---|---|
| ≥ 0.8 | `HIGH` |
| 0.5 – 0.79 | `MEDIUM` |
| < 0.5 | `LOW` |

```json
{
  "stories": [
    {
      "storyId": "redis-license-change",
      "section": "DEVELOPER_OSS",
      "mustKnow": true,
      "title": "Redis 轉 SSPL,商業服務使用者需在 11 月前決定去留",
      "whatHappened": "維護者公告自 11 月 1 日發布的版本起改採 SSPL,既有版本維持原授權不回溯。將該套件作為受管理服務轉售者需另行取得商業授權,內部自用不受限制。",
      "whyItMatters": "多數團隊屬內部自用,不受影響;但若你的產品把它包成對外服務的一部分,合規狀態會在 11 月改變。",
      "whatChanged": "此前僅有社群揣測,今日為維護者首次正式公告,並首次給出生效日與豁免範圍。",
      "impact": "對外提供受管理服務的團隊需在 11 月前評估商業授權或遷移至 fork。內部自用者無需動作。",
      "confidence": "HIGH",
      "sourceItemIds": ["itm_0f3a91", "itm_0f3a92"],
      "factRefs": []
    }
  ],
  "emergingSignals": [
    {
      "label": "基礎設施專案的授權收緊",
      "body": "本週第三個獨立的基礎設施專案調整授權條款。三者分屬不同公司、不同領域,共同壓力來自雲端商的免費轉售模式。這不是單一專案的商業決定,而是一類專案在同一個結構性壓力下的一致反應。若為巧合,後續數週應不再出現同類動作。",
      "storyIds": ["redis-license-change", "otherproj-license-change", "thirdproj-relicense"]
    }
  ],
  "dailyAnalysis": "今日三則 A 級事件都有明確行動期限,共同指向同一件事:過去可以無限期延後的依賴決策,現在被外部方設定了截止日。授權變更、API 定價調整與版本 EOL 分屬不同 section,但對讀者是同一種工作 —— 盤點依賴、評估遷移成本、在期限前下決定。",
  "watchNext": [
    "11 月 1 日前是否出現社群 fork,以及主要雲端商是否公布因應方案",
    "該漏洞的修補是否回溯涵蓋 3.0 至 3.3 分支"
  ]
}
```

---

## 常見拒絕原因與修法

| 錯誤 | 修法 |
|---|---|
| unrecognized key | 移除那個欄位。schema 是 strict,不接受額外欄位 |
| `stories` 少於 8 / 多於 15(brief) | 從 materials 補足或刪減 |
| `mustKnow` 數量不在 3–5 | 調整 boolean,不要改總則數 |
| score 超出 0..1 | 你可能寫了 85 而不是 0.85 |
| `confidence` 型別錯誤(brief) | brief 用 `HIGH`/`MEDIUM`/`LOW`,不是浮點數 |
| `primarySourceIds` 為空 | 至少要指認 1 個 |
| storyId 不存在 | 先 `upsert_story`(Curator)或確認它在 materials 裡(Editor) |
| 送了 `date` / `producedAt` / `decidedAt` | 移除。server 自己加 |
| materials 送了 `relevance` 或 `status` | 移除。那兩個欄位只存在於 ledger entry |
| 仍有未決 item | 繼續 `list_unseen_items` + `record_item_decisions` 直到 unseen 為零 |
