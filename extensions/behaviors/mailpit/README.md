# @lllama/mailpit

A swamp behavior type wrapping the [Mailpit](https://mailpit.axllent.org) v1
HTTP API. Mailpit is a self-hosted email testing tool (SMTP catch-all with a web
UI); this extension turns it into typed behavior methods so swamp workflows can
send test mail, assert messages arrived, inspect their contents, and clean the
mailbox between runs — no shell steps, no curl.

## Installation

```sh
swamp extension install @lllama/mailpit
```

## Usage

Create a definition pointing at your Mailpit server, then run methods:

```sh
swamp behavior create @lllama/mailpit ci-mail \
  --arg url=http://localhost:8025

swamp behavior run ci-mail list
swamp behavior run ci-mail search --input query='to:ci@example.com'
swamp behavior run ci-mail send \
  --input from=no-reply@example.com \
  --input to=ci@example.com \
  --input subject='Nightly build' \
  --input text='All green'
```

Because read methods publish resources, a workflow step can assert delivery with
a CEL expression:

```sh
swamp data query 'behavior("ci-mail") && name == "messages-search"' \
  --select 'attributes.total'
```

## Methods

- `stats` — server counters (total, unread, version, uptime)
- `list` — newest-first mailbox snapshot with counts
- `search` — run a Mailpit search expression (e.g. `to:`, `tag:`)
- `get` — one full message by ID or `latest`
- `send` — send a message via the Send API
- `markRead` — set read status for IDs, a search, or the whole mailbox
- `delete` — delete by ID; requires `all=true` to purge everything

## How it works

All methods call the Mailpit REST API (`/api/v1/...`) over HTTP and publish
their results as versioned swamp data. Pre-flight checks verify the server is
reachable before mutating methods run. Authentication is Mailpit's optional
Basic Auth: set `username` and `password` global arguments on the definition,
ideally via a vault expression such as
`${{ vault.get("default", "mailpit-password") }}` — never hardcode credentials.
The `delete` method refuses to purge the whole mailbox unless you pass
`all=true`, because Mailpit's API deletes everything when no IDs are supplied.

## License

MIT — see LICENSE for details.
