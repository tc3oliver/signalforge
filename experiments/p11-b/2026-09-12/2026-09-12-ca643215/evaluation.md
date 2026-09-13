# Evaluation — 2026-09-12

Run: `unknown`  ·  Evaluated: 2026-09-13T09:38:04.586Z
Overall: **PASS**

| Metric | Value | Threshold | Pass |
| --- | --- | --- | --- |
| scan_coverage | 1.000 | >= 1 | PASS |
| important_story_recall | 1.000 | >= 0.9 | PASS |
| selected_story_precision | 1.000 | >= 0.85 | PASS |
| cluster_precision | 1.000 | — | — |
| cluster_recall | 0.945 | — | — |
| cluster_f1 | 0.972 | >= 0.9 | PASS |
| change_type_accuracy | 0.929 | >= 0.85 | PASS |
| noise_rejection_rate | 1.000 | >= 0.95 | PASS |
| fabricated_source_ids | 0 | <= 0 | PASS |
| invalid_fact_refs | 0 | <= 0 | PASS |
| final_duplicate_stories | 0 | <= 0 | PASS |
| final_story_count | 11 | 8..15 | PASS |
| must_know_count | 4 | 3..5 | PASS |
| schema_validity | 1 | == 1 | PASS |
| structured_output_after_retry | 1 | == 1 | PASS |

## Failed gates

None.

## Detail

- `scan_coverage`: 81/81 manifest items have a decision; 0 undecided
- `important_story_recall`: 11/11 important gold events reached the brief; missed: none
- `selected_story_precision`: 11/11 brief stories match an important gold event; unjustified: none
- `cluster_precision`: TP=69, predicted pairs=69, gold pairs=73 (noise items excluded)
- `cluster_recall`: TP=69, predicted pairs=69, gold pairs=73 (noise items excluded)
- `cluster_f1`: TP=69, predicted pairs=69, gold pairs=73 (noise items excluded); precision=1.000, recall=0.945
- `change_type_accuracy`: 13/14 matched stories carry the expected changeType; wrong: meridian-3-opus-release: NEW != CONFIRMATION
- `noise_rejection_rate`: 26/26 noise items kept out of the brief; leaked: none
- `fabricated_source_ids`: 0 brief sourceItemIds are absent from the manifest's 81 items
- `invalid_fact_refs`: 0 brief factRefs are absent from the manifest's 13 facts
- `final_duplicate_stories`: 0 story pairs overlap at jaccard >= 0.6; 0 repeated storyIds
- `final_story_count`: 11 stories in the brief; allowed 8..15
- `must_know_count`: 4 stories flagged mustKnow; allowed 3..5
- `schema_validity`: brief parsed against DailyBrief
- `structured_output_after_retry`: 0 schema-failing attempt(s) before a valid structured output
