## What this changes

<!-- The behaviour, not the diff. One paragraph. -->

## Why

<!-- What was wrong, or what was not possible before. -->

## Verification

<!-- What you actually ran, and what it said. Paste the result, not a claim. -->

- [ ] `pnpm verify` passes (typecheck, full suite with **0 skipped**, web build)
- [ ] New behaviour has a test that fails without this change
- [ ] No `test.skip`, `.only`, TODO placeholder or unimplemented branch
- [ ] No acceptance gate, threshold or gold file was weakened to make a result fit
- [ ] No credential, token or personal path appears anywhere in the diff

## Scope

- [ ] This does **not** change agent prompts, editorial policy or thresholds
      <!-- If it does, say so here and explain what evidence supports it. Those
           changes alter what the product decides is worth reading, and need
           more than a passing test. -->
