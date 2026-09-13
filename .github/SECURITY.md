# Security policy

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository
(Security → Report a vulnerability). That keeps the report private until there
is something to disclose, and it is the only channel — there is no security
email address for this project.

Please do not open a public issue for a vulnerability, and do not include a
working exploit in the first report. A description of the class of problem, the
affected component and the conditions needed to reach it is enough to start.

This is an unsupported personal project. Reports are read, but there is no
response-time commitment and no bounty. If a fix matters to you on a deadline,
fork and fix it.

## Never include a credential in a report

Not in an issue, not in a pull request, not in a log excerpt, not in a test
fixture. If you believe you have already pasted one somewhere public, treat it
as compromised and rotate it — that advice applies regardless of how quickly the
text was deleted.

## What is in scope

SignalForge's own threat model is written up in
[`docs/SECURITY.md`](../docs/SECURITY.md), including what is deliberately out of
scope and the tests that enforce each boundary. In summary:

**Untrusted external content.** Everything a collector fetches is hostile input
and is marked as such before any agent sees it. **Prompt injection through a
collected item is in scope** — if you can make a fetched article, release note
or comment change what the curator or editor does, that is a vulnerability and
worth reporting.

**Restricted agent runtime.** The agent sessions have no shell, no filesystem
access beyond one narrowly-rooted reader for policy documents, no arbitrary
HTTP, and no credentials. Anything that escapes that is in scope. A change that
relaxes any of it must say so explicitly in its description.

**Secret handling.** Credentials live outside the repository — in
`~/.config/daily-intelligence/secrets.env` or the OS keychain — and are resolved
server-side. The agent never receives one. Values are never logged, never put in
a command argument, and never included in an error message. A path that leaks a
value into a log, a run artifact or a rendered page is in scope.

**Third-party model providers are a trust boundary.** Item text is sent to
whichever provider you configure, under that provider's terms, and SignalForge
makes no claim about what they do with it. Choosing a provider is your decision;
"the model provider retained my data" is not a vulnerability in this project,
but a path that sends them more than the pipeline needs to is.

## Out of scope

- Findings that require an attacker who already has local access to the machine
  or to the database.
- Anything about deploying this on a public network. It is designed to be
  loopback-only and unauthenticated on that assumption; exposing it to the
  Internet is unsupported, not a vulnerability.
- Vulnerabilities in dependencies, unless this project's use of them is what
  makes them reachable. Report those upstream.
