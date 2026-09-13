# SignalForge — 2026-04-17

*Synthetic example. Every story, company, number and link below is invented.*

## Must Know

### Meridian ships Halyard 3.0 with a rewritten scheduler

**What changed:** Halyard 3.0 is out, and the release replaces the cooperative
scheduler that has been in place since 1.0 with a preemptive one. The migration
note is the story: existing operators with custom task priorities have to rewrite
them, and there is no compatibility shim.

**Why it matters:** Halyard sits under a lot of batch infrastructure. A
scheduler swap is the kind of change that is invisible until a queue behaves
differently under load, and the absence of a shim means the upgrade cannot be
done incrementally.

**What we knew before:** The preemptive scheduler was announced as
experimental in 2.7 (2026-01-22) and was opt-in behind a flag. This release
makes it the only option — an escalation, not new information.

Sources:
- [Meridian — Halyard 3.0 release notes](https://meridian.example.com/halyard/3.0)
- [Halyard 3.0 migration guide](https://docs.example.com/halyard/migrating-to-3)
- [Discussion thread](https://forum.example.com/t/halyard-3-scheduler/1182)

### Northwind discloses credential exposure in build logs

**What changed:** Northwind published an incident report: build logs for its
hosted CI product retained environment variables for 19 days, and the logs were
readable by any member of the same organisation.

**Why it matters:** The exposure window covers a routine key-rotation period,
so organisations that rotated during it may have written the new secret into a
readable log. Northwind has invalidated tokens it issued but cannot invalidate
third-party credentials that customers stored.

**What we knew before:** Nothing. First report of this incident.

Sources:
- [Northwind incident report NW-2026-004](https://status.example.com/incidents/nw-2026-004)
- [Coverage](https://sectoday.example.com/northwind-build-log-exposure)

## Research

### Sparse attention result reproduced at a second lab

**What changed:** The Calder group published a reproduction of the "windowed
recall" result from February, at a different scale and on a different corpus.
The effect holds, about 20% weaker than originally reported.

**Why it matters:** The original paper was the basis for three follow-on
architecture proposals. A weaker-but-real effect changes the cost-benefit of all
three without invalidating them.

**What we knew before:** The original result (2026-02-03) was flagged then as
single-lab and unreproduced. This is a confirmation, with a caveat.

Sources:
- [Calder et al., preprint](https://arxiv.example.com/abs/2604.01887)

## Daily Analysis

Two of today's three stories are continuations rather than new information,
which is the more common shape: the Halyard scheduler and the sparse-attention
result were both already in the ledger and both moved. The Northwind disclosure
is the only genuinely new event, and it is the one worth acting on today —
specifically by checking whether any rotation happened inside the stated window.

## Watch Next

- Whether Halyard publishes a compatibility shim after the migration complaints
- Whether Northwind extends the exposure window as its investigation continues
- Whether a third lab attempts the windowed-recall reproduction at full scale

## Emerging Signals

- **Build-log retention as an exposure class** — third such disclosure in six
  weeks, from unrelated vendors. Observed 3 times, first seen 2026-03-06.
  Status: STRENGTHENING.
