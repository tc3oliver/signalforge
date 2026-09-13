# Examples

Synthetic output, so that you can see what SignalForge produces without running
it and without reading somebody else's actual reading list.

Everything here is fabricated. The companies, releases, incidents and numbers
are invented, the URLs point at `example.com`, and no file in this directory
was produced by a real run. That is deliberate: a published brief is a record of
what one person read on one morning, and it is not open-source sample data.

| File | What it shows |
|---|---|
| [`sample-brief.md`](sample-brief.md) | A rendered daily brief, as written to `briefs/<date>/` and shown in the web reader |
| [`sample-run-summary.json`](sample-run-summary.json) | The run record: what each collector did, what the curator decided, which model wrote it |
| [`sample-observation.json`](sample-observation.json) | One story's ledger history across four days, showing change types |

To generate a real (still synthetic) three-day history in your own database and
browse it in the web reader:

```bash
pnpm demo          # seeds the "web-dev" lineage; never touches "default"
DI_LINEAGE=web-dev pnpm run web:start
```
