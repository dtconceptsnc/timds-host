# Verification and private operational records

Public validation should describe reproducible behavior using disposable,
synthetic systems. Run the build checks and relevant tests documented in the
[CI guide](ci.md) and [conformance package](../conformance/README.md).

Live acceptance requires a configured host, normal authentication and the
appropriate per-source publisher grant. Exercise editing, reviewed submission,
preview, publication, replay, rollback, cleanup and immutable public reads.
Check identities and digests without publishing customer records.

Store deployment inventories and acceptance receipts privately. They may contain
customer names, domains, organization/source identifiers, object keys, commits,
release hashes, user identities and operational paths even when they contain no
credentials. Removing names alone does not anonymize those records.

Operational evidence formerly linked by these docs is retained privately.
References marked “private operational record” are not public download links.
Detailed in-progress publication recovery remains with the installation operator;
it must not be copied into public issues, PR descriptions or commit messages.

Public documentation and fixtures should use synthetic data and reserved example
domains. Keep actual installation configuration outside the tracked repository.
