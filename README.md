# n8n-nodes-mailtester-ninja

The official [MailTester Ninja](https://mailtester.ninja) node for [n8n](https://n8n.io). Verify email addresses in real time inside any workflow, and find a person's work email from their name and company domain.

Every check talks to the recipient's own mail server over SMTP and stops before any message is sent. You get a plain verdict back, and MailTester Ninja keeps no copy of the addresses you verify.

[Installation](#installation) · [Credentials](#credentials) · [Operations](#operations) · [Usage](#usage) · [Compatibility](#compatibility) · [Resources](#resources)

## Installation

In n8n, open **Settings > Community Nodes**, select **Install**, and enter:

```
n8n-nodes-mailtester-ninja
```

See the n8n guide to [installing community nodes](https://docs.n8n.io/integrations/community-nodes/installation/) for self-hosted setups.

## Credentials

Create a **MailTester Ninja API** credential and paste your key:

- **Free API token** (starts with `mtf_`): 50 checks a day, one request every 30 seconds, no card. Get one at https://mailtester.ninja/free-email-verification-api/
- **Paid key** (starts with `sub_`): from 100,000 checks a day, see https://mailtester.ninja/verify-emails-unlimited/

The key is sent as the `key` query parameter. **Test** checks that the key is accepted without probing any mail server.

## Operations

### Verify

Checks one address. Output:

| Field | Meaning |
|---|---|
| `code` | `ok` valid, `ko` invalid, `mb` uncertain |
| `message` | `Accepted`, `Rejected`, `Catch-All`, `No MX`, `MX Error`, `Disposable`, `Timeout`, `SPAM Block`, `Limited` |
| `email`, `domain`, `mx` | The address checked, its domain and the mail server that answered |

Treat `mb` as uncertain, never as valid: a catch-all domain accepts every address, so no single mailbox can be confirmed there.

### Find (paid key)

Takes a first name, a last name, a company domain and an optional middle name. Tries the usual patterns (`first.last`, `flast`, `first`...) three at a time and returns the first address the mail server accepts. It stops early on catch-all domains, domains without a mail server and disposable domains. Each pattern tried counts as one verification. Output: `found`, `email`, `code`, `message`, `tried`, `reason`.

## Usage

- **Clean sign-ups:** Webhook or form trigger, then **Verify**, then an **If** node on `code` equal to `ok` before you write to your CRM.
- **Clean a list:** Google Sheets rows, then **Verify**, then write `code` and `message` back to the sheet.
- **Enrich leads:** a row with first name, last name and company domain, then **Find**, then your outreach tool.
- **AI agents:** the node can be used as a tool by the n8n AI Agent, so the agent can check an address before it sends anything.

With the free token, keep one request every 30 seconds (for example with a **Wait** node or batches of one). Paid keys allow about 11 requests every 10 seconds, more on higher plans.

## Compatibility

Built with the n8n node CLI on n8n Nodes API version 1. No runtime dependencies.

## Resources

- [MailTester Ninja API documentation](https://mailtester.ninja/api/)
- [OpenAPI specification](https://mailtester.ninja/openapi.json)
- [n8n integration guide](https://mailtester.ninja/integrations/n8n/)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## License

[MIT](LICENSE.md)
