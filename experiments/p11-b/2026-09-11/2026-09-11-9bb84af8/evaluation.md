# Evaluation — 2026-09-11

Run: `unknown`  ·  Evaluated: 2026-09-13T09:32:46.959Z
Overall: **PASS**

| Metric | Value | Threshold | Pass |
| --- | --- | --- | --- |
| scan_coverage | 1.000 | >= 1 | PASS |
| important_story_recall | 0.909 | >= 0.9 | PASS |
| selected_story_precision | 1.000 | >= 0.85 | PASS |
| cluster_precision | 1.000 | — | — |
| cluster_recall | 0.947 | — | — |
| cluster_f1 | 0.973 | >= 0.9 | PASS |
| change_type_accuracy | 0.867 | >= 0.85 | PASS |
| noise_rejection_rate | 1.000 | >= 0.95 | PASS |
| fabricated_source_ids | 0 | <= 0 | PASS |
| invalid_fact_refs | 0 | <= 0 | PASS |
| final_duplicate_stories | 0 | <= 0 | PASS |
| final_story_count | 10 | 8..15 | PASS |
| must_know_count | 4 | 3..5 | PASS |
| schema_validity | 1 | == 1 | PASS |
| structured_output_after_retry | 1 | == 1 | PASS |

## Failed gates

None.

## Detail

- `scan_coverage`: 82/82 manifest items have a decision; 0 undecided
- `important_story_recall`: 10/11 important gold events reached the brief; missed: evt-20260911-std-fusion-round
- `selected_story_precision`: 10/10 brief stories match an important gold event; unjustified: none
- `cluster_precision`: TP=72, predicted pairs=72, gold pairs=76 (noise items excluded)
- `cluster_recall`: TP=72, predicted pairs=72, gold pairs=76 (noise items excluded)
- `cluster_f1`: TP=72, predicted pairs=72, gold pairs=76 (noise items excluded); precision=1.000, recall=0.947
- `change_type_accuracy`: 13/15 matched stories carry the expected changeType; wrong: corvid-talos-acquisition-talks: NEW != RUMOR; ashgrove-utilities-dividend-q3: UPDATE != NEW
- `noise_rejection_rate`: 26/26 noise items kept out of the brief; leaked: none
- `fabricated_source_ids`: 0 brief sourceItemIds are absent from the manifest's 82 items
- `invalid_fact_refs`: 0 brief factRefs are absent from the manifest's 12 facts
- `final_duplicate_stories`: 0 story pairs overlap at jaccard >= 0.6; 0 repeated storyIds
- `final_story_count`: 10 stories in the brief; allowed 8..15
- `must_know_count`: 4 stories flagged mustKnow; allowed 3..5
- `schema_validity`: brief parsed against DailyBrief
- `structured_output_after_retry`: 0 schema-failing attempt(s) before a valid structured output
