# Evaluation — 2026-09-11

Run: `unknown`  ·  Evaluated: 2026-09-13T09:48:13.627Z
Overall: **FAIL**

| Metric | Value | Threshold | Pass |
| --- | --- | --- | --- |
| scan_coverage | 1.000 | >= 1 | PASS |
| important_story_recall | 1.000 | >= 0.9 | PASS |
| selected_story_precision | 1.000 | >= 0.85 | PASS |
| cluster_precision | 1.000 | — | — |
| cluster_recall | 1.000 | — | — |
| cluster_f1 | 1.000 | >= 0.9 | PASS |
| change_type_accuracy | 0.824 | >= 0.85 | FAIL |
| noise_rejection_rate | 1.000 | >= 0.95 | PASS |
| fabricated_source_ids | 0 | <= 0 | PASS |
| invalid_fact_refs | 0 | <= 0 | PASS |
| final_duplicate_stories | 0 | <= 0 | PASS |
| final_story_count | 11 | 8..15 | PASS |
| must_know_count | 4 | 3..5 | PASS |
| schema_validity | 1 | == 1 | PASS |
| structured_output_after_retry | 1 | == 1 | PASS |

## Failed gates

- **change_type_accuracy** — 14/17 matched stories carry the expected changeType; wrong: basalt-engine-revenue-share-license-rumor: NO_MATERIAL_CHANGE != RUMOR; sable-orm-6-2-silent-data-loss: CONFIRMATION != ESCALATION; ashgrove-utilities-dividend-declaration: UPDATE != NEW

## Detail

- `scan_coverage`: 82/82 manifest items have a decision; 0 undecided
- `important_story_recall`: 11/11 important gold events reached the brief; missed: none
- `selected_story_precision`: 11/11 brief stories match an important gold event; unjustified: none
- `cluster_precision`: TP=76, predicted pairs=76, gold pairs=76 (noise items excluded)
- `cluster_recall`: TP=76, predicted pairs=76, gold pairs=76 (noise items excluded)
- `cluster_f1`: TP=76, predicted pairs=76, gold pairs=76 (noise items excluded); precision=1.000, recall=1.000
- `change_type_accuracy`: 14/17 matched stories carry the expected changeType; wrong: basalt-engine-revenue-share-license-rumor: NO_MATERIAL_CHANGE != RUMOR; sable-orm-6-2-silent-data-loss: CONFIRMATION != ESCALATION; ashgrove-utilities-dividend-declaration: UPDATE != NEW
- `noise_rejection_rate`: 26/26 noise items kept out of the brief; leaked: none
- `fabricated_source_ids`: 0 brief sourceItemIds are absent from the manifest's 82 items
- `invalid_fact_refs`: 0 brief factRefs are absent from the manifest's 12 facts
- `final_duplicate_stories`: 0 story pairs overlap at jaccard >= 0.6; 0 repeated storyIds
- `final_story_count`: 11 stories in the brief; allowed 8..15
- `must_know_count`: 4 stories flagged mustKnow; allowed 3..5
- `schema_validity`: brief parsed against DailyBrief
- `structured_output_after_retry`: 0 schema-failing attempt(s) before a valid structured output
