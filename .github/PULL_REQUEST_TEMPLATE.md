## What changed

<!-- One paragraph. Name the document that specifies the behaviour if runtime code changed. -->

## Checks

<!-- Keep the lines that ran and say what they showed. Delete the rest or mark them skipped and why. -->

- `npm run typecheck`:
- `npm run build`:
- `npm test` / `node --test <suites>`:
- `npm run check:docs`:
- `npm run check:boundary`:
- `cd conformance && npm test`:
- Deployed acceptance (host, disposable source, what was exercised, or "not performed"):

## Public boundary

- [ ] No customer names, domains, organization/source IDs, release hashes, object keys, installation inventories or operational receipts in the diff, this description or the commits.
- [ ] Examples use synthetic names and reserved example domains.
- [ ] `.env`, `.env.deploy-state.json` and `docs/evidence/` are untouched.
- [ ] Unrelated edits in the working tree were preserved, not reverted.
