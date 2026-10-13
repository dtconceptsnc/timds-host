# Public repository privacy

This is a public, reusable host repository. Do not commit customer names, domains,
organization/source IDs, production source/release commits or hashes, object keys,
customer content, deployment inventories, or resumable customer work records.
Use synthetic identities and reserved example domains in documentation and fixtures.
Generic protocol terms such as OAuth client are appropriate.

Keep operational receipts and installation-specific configuration in private
operator storage outside this repository. The ignored `docs/evidence/` path must
not be force-added. PR descriptions, comments and commit messages follow the same
privacy boundary. Public documentation should explain reproducible validation;
it should not link to customer-specific operational records.

Preserve unrelated edits. Documentation and example-only changes need a focused
reference/link check; runtime changes also require appropriate existing checks.
