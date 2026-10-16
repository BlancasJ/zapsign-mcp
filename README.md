# zapsign-mcp

An [MCP](https://modelcontextprotocol.io) server for the [ZapSign](https://zapsign.com.br) API, built for
working with an AI agent without handing it your signers' personal data:

- **48 tools**: every request of ZapSign's public Postman collection plus the ones its documentation adds
  (documents, signers, templates, webhooks, users, plan, background checks, partner accounts).
- **Reads run freely, writes ask every time.** A tool that changes something carries Claude Code's
  `anthropic/requiresUserInteraction` mark, so Claude Code asks before every call in any permission mode.
  Other clients are offered the reads only.
- **Production is read-only.** The `prod` server offers no write tool at all; `sandbox` has them all.
- **The model sees a filtered copy of each answer.** Names, emails, document numbers, states and dates
  pass; CPF, CNPJ, RFC, CURP, dates of birth, photos, signing links, IP addresses, location, phone fields,
  form answers and background-check findings are hidden.
- **You keep the whole answer** in a local log; the agent gets the entry's id, never where the log is.
- **No dependencies.** One Node file speaks MCP over stdio; nothing to build or install.

This project is not affiliated with ZapSign. ZapSign publishes its own MCP server at
[ZapSign/api-mcp](https://github.com/ZapSign/api-mcp).

## Requirements

- Node.js 22 or newer.
- A ZapSign API token for each environment you use: sandbox, production or both
  (ZapSign: Settings → Integration → ZapSign API).

## Install

Pick one:

- **From npm** (recommended). Nothing to download by hand: Claude Code starts the server with
  `npx -y zapsign-mcp@1.0.1 <environment>`, which fetches that exact version the first time and reuses it
  after that. The version is pinned on purpose: a new release runs only when you change the number.
  Every version on [npm](https://www.npmjs.com/package/zapsign-mcp) from 1.0.1 on is built from this
  repository by GitHub Actions and goes live only after its maintainer approves it with 2FA.
- **From source.** Clone the repository and start the server with Node; update it with `git pull`.

  ```sh
  git clone https://github.com/BlancasJ/zapsign-mcp.git ~/zapsign-mcp
  ```

  Then, in the commands below, use `node ~/zapsign-mcp/bin/zapsign-mcp.js sandbox` in place of
  `npx -y zapsign-mcp@1.0.1 sandbox`.

## Setup

### 1. Give it your token

Each environment reads its own variable, `ZAPSIGN_SANDBOX_TOKEN` or `ZAPSIGN_PROD_TOKEN`, and never the
other's. The token is read when a tool is called, not when the server starts.

On macOS you can keep the token in the Keychain instead of in a configuration file. The server reads it from
there when the variable is not set:

```sh
security add-generic-password -s zapsign-mcp-sandbox -a "$USER" -w   # asks for the sandbox token
security add-generic-password -s zapsign-mcp-prod -a "$USER" -w      # asks for the production token
```

### 2. Add it to Claude Code

One server per environment, named `zapsign-sandbox` and `zapsign-prod` (the permission rules below use
these names):

```sh
# With the token in the Keychain (macOS)
claude mcp add --scope user zapsign-sandbox -- npx -y zapsign-mcp@1.0.1 sandbox
claude mcp add --scope user zapsign-prod -- npx -y zapsign-mcp@1.0.1 prod

# With the token in a variable (any system). Claude Code keeps it in ~/.claude.json.
claude mcp add --scope user zapsign-sandbox -e ZAPSIGN_SANDBOX_TOKEN=your-token -- npx -y zapsign-mcp@1.0.1 sandbox
```

Writes ask through a mark Claude Code honours (its MCP documentation, "Require approval for a specific
tool"). In `dontAsk` mode, which never asks, a write is refused instead.

### 3. Add the permission rules and the sandbox

Merge [`examples/claude-settings.json`](examples/claude-settings.json) into `~/.claude/settings.json`:

- `permissions.allow`: the reads (`get_*`, `list_*`) run without asking.
- `permissions.ask`: each verb that changes something (`create_*`, `add_*`, `update_*`, `delete_*`…) asks.
  The mark on the tools already makes Claude Code ask; these rules are a second layer.
- `permissions.deny`: the agent's file tools may not read the log folder, and WebFetch may not reach
  ZapSign's API.
- `sandbox`: turns on Claude Code's [Bash sandbox](https://code.claude.com/docs/en/sandboxing). No shell
  command, and no program one starts (a Python or Node script included), can read the log folder or reach
  ZapSign's API, even with your token in hand. `autoAllowBashIfSandboxed: false` keeps Claude Code asking
  before commands as it did: without it, turning the sandbox on lets every sandboxed command run unasked.

**Keep the `deny` rules and the `sandbox` block**: without them the agent can open the unfiltered answers,
or call ZapSign without this server. If you set `XDG_STATE_HOME`, change the log path in both to
`$XDG_STATE_HOME/zapsign-mcp`.

The sandbox also limits what every other command can do: by default it writes only in the working folder
and the temporary one, and a host it has not reached before asks once per session. Widen it with
`sandbox.filesystem.allowWrite` and `sandbox.network.allowedDomains`; `deniedDomains` still wins over them.

## Tools

Reads (run freely):

| Tool | Request |
| --- | --- |
| `get_document` | `GET /api/v1/docs/{doc_token}/` |
| `list_documents` | `GET /api/v1/docs/` |
| `get_document_audit_trail` | `GET /api/v1/docs/signer-log/{doc_token}` |
| `get_signer` | `GET /api/v1/signers/{signer_token}/` |
| `get_signer_validations` | `GET /api/v1/signer-verification-details/{signer_token}/` |
| `list_templates` | `GET /api/v1/templates/` |
| `get_template` | `GET /api/v1/templates/{template_token}/` |
| `get_plan` | `GET /api/v1/info-plan/` |
| `list_users` | `GET /api/v1/users/` |
| `get_partner_plans_csv` | `GET /api/v1/info-plan/partners-csv/` |
| `get_background_check` | `GET /api/v1/checks/{check_id}/` |
| `get_background_check_details` | `GET /api/v1/checks/{check_id}/details/` |

Writes (sandbox only, and each call asks first):

| Tool | Request |
| --- | --- |
| `create_document` | `POST /api/v1/docs/` |
| `create_document_async` | `POST /api/v1/docs/async/` |
| `create_document_from_template` | `POST /api/v1/models/create-doc/` |
| `create_document_from_template_async` | `POST /api/v1/models/create-doc/async/` |
| `add_extra_document` | `POST /api/v1/docs/{doc_token}/upload-extra-doc/` |
| `add_extra_document_from_template` | `POST /api/v1/models/{doc_token}/upload-extra-doc/` |
| `place_signatures` | `POST /api/v1/docs/{doc_token}/place-signatures/` |
| `reorder_envelope_documents` | `PUT /api/v1/docs/{doc_token}/document-display-order/` |
| `resend_notifications` | `POST /api/v1/docs/{doc_token}/resend-notifications-bulk/` |
| `update_document` | `PUT /api/v1/docs/{doc_token}/` |
| `reprocess_document` | `POST /api/v1/docs/{doc_token}/reprocess-doc/` |
| `delete_document` | `DELETE /api/v1/docs/{doc_token}/` |
| `delete_signer_groups` | `DELETE /api/v1/signature-group/{doc_token}/` |
| `reject_document` | `POST /api/v1/refuse/` |
| `reject_document_by_user` | `POST /api/v1/refuse/by-user/` |
| `validate_pdf_signature` | `POST /api/v1/validate-pdf-signature/` (uploads a local PDF) |
| `sign_in_batch` | `POST /api/v1/sign/` |
| `add_timestamp` | `POST /api/v1/timestamp/` |
| `add_timestamp_keeping_signature` | `POST /api/v1/timestamp/no-signature` |
| `add_signer` | `POST /api/v1/docs/{doc_token}/add-signer/` |
| `update_signer` | `POST /api/v1/signers/{signer_token}/` |
| `delete_signer` | `DELETE /api/v1/signer/{signer_token}/remove/` |
| `reset_signer_validation_attempts` | `PUT /api/v1/reset-auth-attempts/{signer_token}/` |
| `create_template` | `POST /api/v1/templates/create` |
| `update_template` | `PUT /api/v1/templates/{template_token}/` |
| `update_template_form` | `POST /api/v1/templates/update-form/` |
| `delete_template` | `DELETE /api/v1/templates/{template_token}/` |
| `create_webhook` | `POST /api/v1/user/company/webhook/` |
| `delete_webhook` | `DELETE /api/v1/user/company/webhook/delete/` |
| `create_webhook_header` | `POST /api/v1/user/company/webhook/header/` |
| `delete_webhook_header` | `DELETE /api/v1/user/company/webhook/header/delete/` |
| `create_user` | `POST /api/v1/users/create-user` |
| `delete_user` | `DELETE /api/v1/users/{user_email}/` |
| `create_background_check` | `POST /api/v1/checks/` |
| `create_partner_account` | `POST /api/v1/partner/company/` |
| `update_partner_payment_status` | `POST /api/v1/partner/update-payment-status/` |

A write takes the request's JSON as `body` and sends it to ZapSign as it is, so every option in
[ZapSign's documentation](https://docs.zapsign.com.br) is available. Tokens and emails that go into a path
are checked first, so they cannot point the request somewhere else.

## What the model sees

[`lib/response-filter.js`](lib/response-filter.js) decides. It lists the keys that may be shown; any other
key keeps its name and shows `[hidden]`, so a field ZapSign adds later is hidden until someone lists it.

- Shown: tokens, states, dates of events, settings, counts, names, emails, an identity document's number.
- Hidden: CPF, CNPJ, RFC, CURP and similar ids (also when written inside a text, with or without
  punctuation), dates of birth, photos and signature images, signing and file links (only the host is shown),
  IP addresses and location, phone fields (the last 4 digits are shown), form answers, background-check
  findings, webhook header values.
- Errors go through the same filter.

Known gaps: the signer token is shown, and it is enough to build a signing link. A phone number,
coordinates or a date of birth written inside free text are not masked.

## The log

Every call is kept whole, with its arguments and ZapSign's full answer, in
`$XDG_STATE_HOME/zapsign-mcp/` (by default `~/.local/state/zapsign-mcp/`), in `sandbox/` and `prod/`:

- one JSON line per call, one file per day, kept for 30 days;
- folders `0700`, files `0600`;
- `webhooks.jsonl` keeps the id of every webhook created, and is never pruned: ZapSign has no request that
  lists webhooks, and the id is the only way to delete one.

The answer the agent gets names the log entry's id, never the folder. The `Read` deny rule keeps Claude
Code's file tools out of it, and the file commands Claude Code recognises in Bash (`cat`, `head`, `tail`);
the sandbox's `denyRead` closes it to every program a shell command starts.

## Limits

The filter and the read-only production server hold only while the agent goes through this server. With the
example settings, a shell command can neither read the log nor reach ZapSign's API (checked on macOS), and
WebFetch cannot reach the API. They do not stop:

- **Reading the token.** A token in the Keychain can be read with `security find-generic-password`, inside
  the sandbox too: it asks a system service, not a file. A token given with `-e` sits in `~/.claude.json`.
  The agent can see the token, though it cannot use it against ZapSign from a shell command or WebFetch.
- **A command you let out of the sandbox.** When a command fails inside it, Claude can ask to run it
  unsandboxed ("Bash command (unsandboxed)"); if you approve, it runs without these limits.
  `"allowUnsandboxedCommands": false` takes that option away.
- **Code that runs outside the sandbox,** such as MCP servers and hooks. An agent you let edit their files
  can change what they do.

## Other clients

The server speaks plain MCP over stdio and works with any client. Only Claude Code honours the
`requiresUserInteraction` mark, so any other client is offered the reads only, and a write it calls anyway
is refused.

## Production writes

`prod` is read-only on purpose. To write in production, remove `readOnly: true` from `ENVIRONMENTS` in
[`bin/zapsign-mcp.js`](bin/zapsign-mcp.js).

## Development

```sh
npm test
```

The tests never reach ZapSign or the Keychain. `tests/zapsign-collection.json` lists every request the
server must have a tool for: the Postman collection's, and the ones only the documentation has.

### Releasing

1. In a pull request, set the new version in `package.json`, in `server.json` (twice) and in the README's
   `npx` commands. The tests fail until all of them agree.
2. Once it is merged, publish a GitHub release whose tag is `v` and that version, such as `v1.0.1`.
3. The [`publish`](.github/workflows/publish.yml) workflow checks the tag against the version, runs the
   tests and stages the version on npm through npm's trusted publishing (no token).
4. Approve the staged version on [npmjs.com](https://www.npmjs.com/package/zapsign-mcp) with 2FA. Only
   then does it go live, and the workflow lists it in the
   [MCP Registry](https://registry.modelcontextprotocol.io). It waits an hour for the approval; after
   that, approve and re-run its `mcp-registry` job.

## License

[MIT](LICENSE)
