# Changelog

## 0.2.0

- Find uses the MailTester Ninja Finder API (`/find`): the 6 most common patterns are tested one by one on the server, within the rate of the key, and the search stops at the first accepted address or at a verdict that applies to the whole domain. Each pattern tested counts as one verification.
- Find: new outputs `guess` (the most common pattern on a catch-all domain), `format` (the pattern found), `confidence` (`high`, `medium` or `low`), `tested` (every address checked, with its verdict) and `domain`. The Middle Name field is removed. Personal email providers such as gmail.com are not searched.
- Automatic rate pacing per API key: Verify and Find stay within the key's rate (no more HTTP 429 on lists or on fast domains), shared by the executions that use the same key.
- On an unexpected HTTP 429 (key used elsewhere at the same time), one retry after 11 seconds, then a clear error.
- With a free token, Verify waits 31 seconds between requests instead of failing.

## 0.1.2

- README: two importable example workflows in `examples/` (verify new sign-ups, find a work email).
- Published through npm trusted publishing (OIDC) from GitHub Actions, with provenance.

## 0.1.1

- First published release (0.1.0 was never published): MailTester Ninja API credential, Verify and Find operations, usable as an AI Agent tool.
