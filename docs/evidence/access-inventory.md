# Cloudflare Access inventory — 13 October 2026

Inventory and approved setup in account `e25df25724ba27024ad08e3096b5bd37`
(DT Concepts LLC). The original inventory was read-only. The new host application
and human policy below were subsequently created with explicit human approval;
the existing runner application, token, identity provider, and team were unchanged.

- Team domain: `https://petindex.cloudflareaccess.com`.
- Plan: Zero Trust Free; dashboard shows 0 of 50 seats used.
- Signed-in dashboard role: Super Administrator — All Privileges.
- Existing identity provider: One-time PIN,
  `28a3982e-db52-414b-bf3a-97a89b24d476`.
- Existing application: **TimDS draft runner**,
  `ba026863-6f8f-4720-ab32-76d5ff9e92cf`, protecting
  `draft-runner.timds.com`.
- Its **Portal service token only** policy
  (`0564faf9-8333-40ff-b9ca-0e2396388d41`) uses Service Auth and includes
  exactly the existing `toperator-portal` service token. It is not a human
  sign-in application and is not to be reused for the new host.
- No reusable policies were listed.

The saved `cf` login reports only user/account and Workers/Builds scopes. Direct
Access organization reads returned HTTP 403 / code 10000. Application, identity
provider, and service-token list endpoints returned HTTP 200 with empty
collections despite the real dashboard records above. These empty lists are
not reliable inventory evidence under this credential. The separately refreshed
broader toolchain OAuth credential also returned 403 for the organization.
No credential values were displayed or copied into the repository.

## Approved host configuration

The user approved the limited setup for
`https://timds-host-69.ratebucket.workers.dev`, staff OTP sign-in, and one dedicated
runner/CI service credential. The dashboard confirmed creation of:

- Application **TimDS open host 69**, ID
  `097b4e3e-791e-4918-b74d-8a7e4177f336`.
- Audience (not a secret):
  `921c2c50fd5378eb09d45dc65fa471b3e2036d98a5e35099c05e6c6b33db7917`.
- Exactly three destinations on that host: `/authorize`, `/bootstrap`, and
  `/service-auth`; no `/api/timds` destination.
- Allow policy **TimDS host 69 staff OTP**, ID
  `93d8db42-0ea1-465b-8d4f-6d2e3dfeea76`, with the exact email
  `staff@dtconcepts.net`; existing One-time PIN provider selected, all-provider
  acceptance disabled, instant authentication enabled.
- Six-hour application sessions, HttpOnly and binding cookies, SameSite Lax,
  hostname-scoped cookie, and no App Launcher listing.

The dedicated token form is prepared as **timds-host-69-runner-ci** with the
shortest dashboard lifetime (one year), but the token has **not** been generated.
The native Terminal secret-capture path was blocked by computer-use safety.
Secure human capture is pending before generation; no new service policy is
active yet and no secret was written to this repository or tool output.

## Configuration intent and helper

Create a distinct self-hosted Access application with one audience covering only
the new host's `/authorize`, `/bootstrap`, and `/service-auth` paths. Keep the
OAuth token, discovery, registration, and Bearer API routes outside an interactive
Access gate. Published HTML must use the separate public Worker origin.

Use the existing One-time PIN provider and an Allow policy for the exact intended
human email. Add a separate Service Auth policy containing only a newly created,
host-specific service-token UUID. The existing draft-runner token must not be
included. Configure a bounded Access JWT lifetime and HttpOnly/binding
cookies. `/service-auth` must return a credential only after the host verifies a
service identity; a human session on the same application must not qualify.

`scripts/access-plan.mjs` generates this bounded application body after receiving
the exact deployed origin, app name, human email, IdP UUID, and new service-token
UUID. It has no API-writing or credential-generating mode. The helper does not
create a new identity provider or expand the existing runner policy. After
creation, record the returned application audience in `ACCESS_AUD` and the team
domain above in `ACCESS_TEAM_DOMAIN`; neither is a secret.

Browser creation of this app or service credential requires action-time human
confirmation under the computer-use policy for new security-sensitive access.
That confirmation was received for the exact scope recorded above. An API setup
requires a credential with Access application/policy and service-token
write permissions; the available CLI credentials do not establish that access.

The request shape follows the current Cloudflare-generated
[Access application types](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/zero-trust/access/applications/applications.ts)
and [application API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/).
The account facts above are from the authenticated dashboard, not inferred from
public documentation.
