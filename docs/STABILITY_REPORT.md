# Stability report

Generated: 2026-09-13T09:54:43.179Z
Experiments: p11-b, p11-c, p11-d
Model(s) observed: gemini-3.8-flash
Dates: 2026-09-10, 2026-09-11, 2026-09-12

Each lineage ran the same days from its own empty ledger, so two lineages
never shared story ids, decisions or run state. Runs are matched by item
membership and gold event mapping -- never by comparing title strings,
which would measure phrasing rather than agreement.

## Acceptance gate

| Metric | Gate | Observed (mean) | Result |
| --- | --- | --- | --- |
| core_story_selection_stability | >= 0.85 | 0.922 | PASS |

The four metrics below it are recorded as measurements, not gates: they
describe where two independent lineages agree and where they diverge.

## Overall (mean across dates)

| Metric | Mean | Unit |
| --- | --- | --- |
| core_story_selection_stability | 0.922 | jaccard |
| must_know_stability | 0.911 | jaccard |
| cluster_stability | 0.981 | f1 |
| change_type_stability | 0.934 | ratio |
| emerging_signal_stability | 0.444 | jaccard |

## 2026-09-10

Runs compared: p11-b=2026-09-10-1c627843, p11-c=2026-09-10-4aed8fcb, p11-d=2026-09-10-e1fc40ea

| Metric | Mean | Unit |
| --- | --- | --- |
| core_story_selection_stability | 0.939 | jaccard |
| must_know_stability | 1.000 | jaccard |
| cluster_stability | 0.995 | f1 |
| change_type_stability | 1.000 | ratio |
| emerging_signal_stability | 0.333 | jaccard |

### core_story_selection_stability — pairwise detail

- p11-b vs p11-c: 0.909 — p11-b published 11 identities, p11-c published 10; jaccard=0.909
- p11-b vs p11-d: 1.000 — p11-b published 11 identities, p11-d published 11; jaccard=1.000
- p11-c vs p11-d: 0.909 — p11-c published 10 identities, p11-d published 11; jaccard=0.909

### must_know_stability — pairwise detail

- p11-b vs p11-c: 1.000 — p11-b flagged 4 mustKnow identities, p11-c flagged 4; jaccard=1.000
- p11-b vs p11-d: 1.000 — p11-b flagged 4 mustKnow identities, p11-d flagged 4; jaccard=1.000
- p11-c vs p11-d: 1.000 — p11-c flagged 4 mustKnow identities, p11-d flagged 4; jaccard=1.000

### cluster_stability — pairwise detail

- p11-b vs p11-c: 0.993 — TP=72, p11-b pairs=72, p11-c pairs=73; f1=0.993
- p11-b vs p11-d: 0.993 — TP=72, p11-b pairs=72, p11-d pairs=73; f1=0.993
- p11-c vs p11-d: 1.000 — TP=73, p11-c pairs=73, p11-d pairs=73; f1=1.000

### change_type_stability — pairwise detail

- p11-b vs p11-c: 1.000 — 10/10 shared gold events assigned the same changeType by p11-b and p11-c
- p11-b vs p11-d: 1.000 — 11/11 shared gold events assigned the same changeType by p11-b and p11-d
- p11-c vs p11-d: 1.000 — 10/10 shared gold events assigned the same changeType by p11-c and p11-d

### emerging_signal_stability — pairwise detail

- p11-b vs p11-c: 0.000 — p11-b cited 0 identities in emergingSignals, p11-c cited 1; jaccard=0.000
- p11-b vs p11-d: 0.000 — p11-b cited 0 identities in emergingSignals, p11-d cited 1; jaccard=0.000
- p11-c vs p11-d: 1.000 — p11-c cited 1 identities in emergingSignals, p11-d cited 1; jaccard=1.000

## 2026-09-11

Runs compared: p11-b=2026-09-11-9bb84af8, p11-c=2026-09-11-25ee3646, p11-d=2026-09-11-4c9f9fb3

| Metric | Mean | Unit |
| --- | --- | --- |
| core_story_selection_stability | 0.939 | jaccard |
| must_know_stability | 1.000 | jaccard |
| cluster_stability | 0.996 | f1 |
| change_type_stability | 0.867 | ratio |
| emerging_signal_stability | 0.333 | jaccard |

### core_story_selection_stability — pairwise detail

- p11-b vs p11-c: 0.909 — p11-b published 10 identities, p11-c published 11; jaccard=0.909
- p11-b vs p11-d: 0.909 — p11-b published 10 identities, p11-d published 11; jaccard=0.909
- p11-c vs p11-d: 1.000 — p11-c published 11 identities, p11-d published 11; jaccard=1.000

### must_know_stability — pairwise detail

- p11-b vs p11-c: 1.000 — p11-b flagged 4 mustKnow identities, p11-c flagged 4; jaccard=1.000
- p11-b vs p11-d: 1.000 — p11-b flagged 4 mustKnow identities, p11-d flagged 4; jaccard=1.000
- p11-c vs p11-d: 1.000 — p11-c flagged 4 mustKnow identities, p11-d flagged 4; jaccard=1.000

### cluster_stability — pairwise detail

- p11-b vs p11-c: 0.993 — TP=75, p11-b pairs=75, p11-c pairs=76; f1=0.993
- p11-b vs p11-d: 0.993 — TP=75, p11-b pairs=75, p11-d pairs=76; f1=0.993
- p11-c vs p11-d: 1.000 — TP=76, p11-c pairs=76, p11-d pairs=76; f1=1.000

### change_type_stability — pairwise detail

- p11-b vs p11-c: 0.800 — 8/10 shared gold events assigned the same changeType by p11-b and p11-c
- p11-b vs p11-d: 0.800 — 8/10 shared gold events assigned the same changeType by p11-b and p11-d
- p11-c vs p11-d: 1.000 — 11/11 shared gold events assigned the same changeType by p11-c and p11-d

### emerging_signal_stability — pairwise detail

- p11-b vs p11-c: 0.000 — p11-b cited 0 identities in emergingSignals, p11-c cited 1; jaccard=0.000
- p11-b vs p11-d: 0.000 — p11-b cited 0 identities in emergingSignals, p11-d cited 1; jaccard=0.000
- p11-c vs p11-d: 1.000 — p11-c cited 1 identities in emergingSignals, p11-d cited 1; jaccard=1.000

## 2026-09-12

Runs compared: p11-b=2026-09-12-ca643215, p11-c=2026-09-12-3ae619ce, p11-d=2026-09-12-64a38a0a

| Metric | Mean | Unit |
| --- | --- | --- |
| core_story_selection_stability | 0.886 | jaccard |
| must_know_stability | 0.733 | jaccard |
| cluster_stability | 0.952 | f1 |
| change_type_stability | 0.936 | ratio |
| emerging_signal_stability | 0.667 | jaccard |

### core_story_selection_stability — pairwise detail

- p11-b vs p11-c: 0.917 — p11-b published 11 identities, p11-c published 12; jaccard=0.917
- p11-b vs p11-d: 0.909 — p11-b published 11 identities, p11-d published 10; jaccard=0.909
- p11-c vs p11-d: 0.833 — p11-c published 12 identities, p11-d published 10; jaccard=0.833

### must_know_stability — pairwise detail

- p11-b vs p11-c: 0.600 — p11-b flagged 4 mustKnow identities, p11-c flagged 4; jaccard=0.600
- p11-b vs p11-d: 1.000 — p11-b flagged 4 mustKnow identities, p11-d flagged 4; jaccard=1.000
- p11-c vs p11-d: 0.600 — p11-c flagged 4 mustKnow identities, p11-d flagged 4; jaccard=0.600

### cluster_stability — pairwise detail

- p11-b vs p11-c: 0.972 — TP=69, p11-b pairs=69, p11-c pairs=73; f1=0.972
- p11-b vs p11-d: 0.926 — TP=63, p11-b pairs=69, p11-d pairs=67; f1=0.926
- p11-c vs p11-d: 0.957 — TP=67, p11-c pairs=73, p11-d pairs=67; f1=0.957

### change_type_stability — pairwise detail

- p11-b vs p11-c: 0.909 — 10/11 shared gold events assigned the same changeType by p11-b and p11-c
- p11-b vs p11-d: 0.900 — 9/10 shared gold events assigned the same changeType by p11-b and p11-d
- p11-c vs p11-d: 1.000 — 10/10 shared gold events assigned the same changeType by p11-c and p11-d

### emerging_signal_stability — pairwise detail

- p11-b vs p11-c: 0.500 — p11-b cited 1 identities in emergingSignals, p11-c cited 2; jaccard=0.500
- p11-b vs p11-d: 1.000 — p11-b cited 1 identities in emergingSignals, p11-d cited 1; jaccard=1.000
- p11-c vs p11-d: 0.500 — p11-c cited 2 identities in emergingSignals, p11-d cited 1; jaccard=0.500
