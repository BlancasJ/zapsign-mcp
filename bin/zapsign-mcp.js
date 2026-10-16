#!/usr/bin/env node
'use strict';
// zapsign-mcp sandbox|prod — an MCP server (stdio) through which an agent works with ZapSign.
//
// A GET is a read (the tools named get_… and list_…) and runs freely. Every other request
// changes something at ZapSign, or sends it a file, and runs only after the user approves that
// very call: it carries the mark that makes Claude Code ask each time, in any permission mode,
// and no other client is offered it. Such a tool is named for what it does, starting with a
// verb (create_, add_, update_, delete_…), so that a settings file can ask per verb too
// (examples/claude-settings.json).
//
// The PROD environment is read-only (`readOnly` below): it offers no write tool at all and
// refuses one if called. Sandbox keeps its writes. Remove the flag to write in production.
//
// One process per environment. The host is fixed by the environment's name. The key is read
// when a tool is called: from ZAPSIGN_SANDBOX_TOKEN or ZAPSIGN_PROD_TOKEN when the client sets
// it, else, on macOS, from the Keychain item stored once per environment with:
//     security add-generic-password -s zapsign-mcp-sandbox -a "$USER" -w
//     security add-generic-password -s zapsign-mcp-prod -a "$USER" -w
//
// The agent receives a filtered copy of every answer (../lib/response-filter.js says what it
// shows). The full answer is kept for the user in the XDG state folder, zapsign-mcp/sandbox/ or
// prod/ under $XDG_STATE_HOME or ~/.local/state, one file per day, 30 days. A created webhook's
// id is kept as well, in webhooks.jsonl there, which is never pruned: ZapSign has no request
// that lists webhooks and the id is the only way to delete one later. No answer says where
// that folder is, and the agent's settings should deny reading it: the unfiltered answers are
// the user's to read. Starting the server sends nothing, reads no key and writes no file.
//
// MCP is spoken by hand (JSON-RPC, one object per line): there is no package to install or
// build, and nothing but Node.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
// Found next to the real file, also through the link npm puts on the PATH.
const { filter, filterCsv } = require('../lib/response-filter.js');

const ENVIRONMENTS = {
  sandbox: {
    host: 'https://sandbox.api.zapsign.com.br', variable: 'ZAPSIGN_SANDBOX_TOKEN', keychain: 'zapsign-mcp-sandbox', logDir: 'sandbox',
  },
  prod: {
    host: 'https://api.zapsign.com.br', variable: 'ZAPSIGN_PROD_TOKEN', keychain: 'zapsign-mcp-prod', logDir: 'prod', readOnly: true,
  },
};
// The log folder: in XDG_STATE_HOME when it is set to an absolute path, else in ~/.local/state.
const logRootFor = (env, home) => path.join(
  env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state'), 'zapsign-mcp',
);
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TIMEOUT_MS = 30000;
const LOG_DAYS = 30;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// What goes into the path of the request: a token is letters, digits and hyphens only, and an
// email has no slash, question mark or hash, so neither can name another path, a query or a
// fragment.
const TOKEN = '^[A-Za-z0-9-]{8,64}$';
const EMAIL_ADDRESS = '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)+$';
const token = (what) => ({ type: 'string', pattern: TOKEN, description: `Token of the ${what}` });
const IN_PATH = {
  doc_token: token('document'),
  signer_token: token('signer'),
  template_token: token('template'),
  check_id: { type: 'string', pattern: TOKEN, description: 'Id of the background check (CHK…)' },
  user_email: { type: 'string', pattern: EMAIL_ADDRESS, description: 'Email of the user' },
};

// One row per request of ZapSign's API. `template` is its path, with the tokens it takes.
const read = (name, template, description, query = {}, options = {}) => ({ name, method: 'GET', template, description, query, ...options });
const write = (name, method, template, description, options = {}) => ({
  name, method, template, description, query: {}, body: 'required', ...options,
});
const NO_BODY = { body: 'none' };
const TOOLS = [
  read('get_document', '/api/v1/docs/{doc_token}/',
    'One document by its token: status, dates, and each signer with their status and signed_at.'),
  read('list_documents', '/api/v1/docs/',
    'Documents of the account, one page at a time, newest first unless sort_order says otherwise.', {
      page: { type: 'integer', minimum: 1 },
      status: { type: 'string', enum: ['pending', 'signed', 'refused'] },
      external_id: { type: 'string' },
      created_by: { type: 'string' },
      folder_path: { type: 'string' },
      created_from: { type: 'string', description: 'YYYY-MM-DD' },
      created_to: { type: 'string', description: 'YYYY-MM-DD' },
      sort_order: { type: 'string', enum: ['asc', 'desc'] },
    }),
  read('get_document_audit_trail', '/api/v1/docs/signer-log/{doc_token}',
    'What happened to a document, event by event: who did what, when, and how they were authenticated.'),
  read('get_signer', '/api/v1/signers/{signer_token}/',
    'One signer by their token: status, signed_at, views and how they must authenticate.'),
  read('list_templates', '/api/v1/templates/',
    'Templates of the account, one page at a time.', { page: { type: 'integer', minimum: 1 } }),
  read('get_template', '/api/v1/templates/{template_token}/',
    'One template by its token: name, language, fields and first signer settings.'),
  read('get_signer_validations', '/api/v1/signer-verification-details/{signer_token}/',
    'Every identity validation a signer went through (document, selfie, name, CPF): its type, status, the reason it failed, and the name and number read from the identity document. Photos and the date of birth stay in the log.'),
  read('get_plan', '/api/v1/info-plan/',
    "The account's plan: name, credits left, status (paid, pending_payment, unpaid, canceled), period and when it ends."),
  read('list_users', '/api/v1/users/',
    'Users of the organization, 25 a page: name, email, whether the email is verified, and permission group.',
    { page: { type: 'integer', minimum: 1 } }),
  read('get_partner_plans_csv', '/api/v1/info-plan/partners-csv/',
    'Partner API: a CSV with one row for this account and one for each partner account under it: plan, credits, status, and usage (documents, envelopes, SMS, WhatsApp, biometrics) over at most 30 days, the last 30 when no date is given.', {
      start_date: { type: 'string', description: 'YYYY-MM-DD' },
      end_date: { type: 'string', description: 'YYYY-MM-DD' },
    }, { csv: true }),
  read('get_background_check', '/api/v1/checks/{check_id}/',
    'A background check by its id: who was checked, status (not_started, in_progress, delayed, error, completed), type, country, and whether its PDF report is ready. Ids, dates of birth and the report link stay in the log.'),
  read('get_background_check_details', '/api/v1/checks/{check_id}/details/',
    'What each database consulted by a background check returned: database, result, severity, the name found and the labels of what it found. The values found stay in the log.', {
      lang: { type: 'string', enum: ['es', 'en', 'pt-br'] },
      start_key: { type: 'string', description: 'The next page: the start_key in the `next` of the previous answer' },
    }),

  write('create_document', 'POST', '/api/v1/docs/',
    'Creates a document from a PDF or a DOCX, with its signers. Body: name, one of url_pdf, base64_pdf, url_docx or base64_docx, signers[], and the other options of the API (lang, external_id, folder_path, one-click fields). Anchors: a signer signs where the PDF carries an anchor text, written in white so it does not show, when the signer has signature_placement (the signature with its details) or rubrica_placement (the bare signature) set to that text. Each signer has their own anchor (<<signer1>>, <<signer2>>, <<signer3>>…), and a signer whose anchor appears several times signs in every place. Anchors work the same in create_document_from_template, add_signer and update_signer.'),
  write('create_document_async', 'POST', '/api/v1/docs/async/',
    'The same as create_document, processed in the background: for large files.'),
  write('create_document_from_template', 'POST', '/api/v1/models/create-doc/',
    'Creates a document from a template. Body: template_id, signer_name, data[] of { de, para }, and the other options of the API.'),
  write('create_document_from_template_async', 'POST', '/api/v1/models/create-doc/async/',
    'The same as create_document_from_template, processed in the background.'),
  write('add_extra_document', 'POST', '/api/v1/docs/{doc_token}/upload-extra-doc/',
    'Attaches another PDF to a document, signed by the same signers. Body: name, url_pdf or base64_pdf.'),
  write('add_extra_document_from_template', 'POST', '/api/v1/models/{doc_token}/upload-extra-doc/',
    'Attaches another document, made from a template, to a document. Body: template_id, data[] of { de, para }.'),
  write('place_signatures', 'POST', '/api/v1/docs/{doc_token}/place-signatures/',
    'Sets where each signer signs or initials on each page. Body: rubricas[].'),
  write('reorder_envelope_documents', 'PUT', '/api/v1/docs/{doc_token}/document-display-order/',
    'Sets the order of a document and its extra documents. Body: document_display_order[], the tokens in the order wanted.'),
  write('resend_notifications', 'POST', '/api/v1/docs/{doc_token}/resend-notifications-bulk/',
    'Sends the signing notification again to every signer of a document who has not signed.', NO_BODY),
  write('update_document', 'PUT', '/api/v1/docs/{doc_token}/',
    'Changes a document that is still pending: its name, signing deadline, folder, or the names of its extra documents. Body: name, date_limit_to_sign (YYYY-MM-DD), folder_path or folder_token, extra_docs[] of { token, name }.'),
  write('reprocess_document', 'POST', '/api/v1/docs/{doc_token}/reprocess-doc/',
    "Sends a document's webhook again, makes its signed PDF again, or both. It runs in the background: check the document a few minutes later. Body: send_webhook, resign_doc; both default to false, so an empty body does nothing."),
  write('delete_document', 'DELETE', '/api/v1/docs/{doc_token}/',
    'Deletes a document, with its signers. It cannot be undone.', { ...NO_BODY, destructive: true }),
  write('delete_signer_groups', 'DELETE', '/api/v1/signature-group/{doc_token}/',
    'Removes the signer groups of a document: its signers go back to how they were before they were grouped.', { ...NO_BODY, destructive: true }),
  write('reject_document', 'POST', '/api/v1/refuse/',
    'Cancels a document: it can no longer be signed. Body: doc_token, rejected_reason, notify_signer.', { destructive: true }),
  write('reject_document_by_user', 'POST', '/api/v1/refuse/by-user/',
    'Refuses a document in the name of a user. Body: doc_token, user_token, and the signer and reason the API asks for.', { destructive: true }),
  write('validate_pdf_signature', 'POST', '/api/v1/validate-pdf-signature/',
    'Sends a signed PDF from this computer to ZapSign, which says whether its signature is valid and who made it.', { ...NO_BODY, upload: true }),
  write('sign_in_batch', 'POST', '/api/v1/sign/',
    'Signs pending documents in the name of a user. A signature made this way binds that person. Body: user_token, signer_tokens[].', { destructive: true }),
  write('add_timestamp', 'POST', '/api/v1/timestamp/',
    'Adds a legal timestamp to a PDF that is public on the web. Body: url.'),
  write('add_timestamp_keeping_signature', 'POST', '/api/v1/timestamp/no-signature',
    'Adds a legal timestamp to a PDF or DOCX already signed with an ICP-Brasil certificate, keeping that signature as the one validators show. Billed: ZapSign answers 402 without credit. Body: url, public, or the file in base64, up to 10 MB.'),
  write('add_signer', 'POST', '/api/v1/docs/{doc_token}/add-signer/',
    'Adds a signer to a document. Body: name and the signer options of the API (email, phone, auth_mode, order_group).'),
  write('update_signer', 'POST', '/api/v1/signers/{signer_token}/',
    'Changes a signer who has not signed yet. Body: the fields to change.'),
  write('delete_signer', 'DELETE', '/api/v1/signer/{signer_token}/remove/',
    'Removes a signer who has not signed yet. It cannot be undone.', { ...NO_BODY, destructive: true }),
  write('reset_signer_validation_attempts', 'PUT', '/api/v1/reset-auth-attempts/{signer_token}/',
    'Lets a signer who failed their validations (selfie, document photo) try again.', NO_BODY),
  write('create_template', 'POST', '/api/v1/templates/create',
    'Creates a template from a DOCX. Body: name, docx_url or base64_docx, lang, observers, first_signer, folder_path, redirect_link.'),
  write('update_template', 'PUT', '/api/v1/templates/{template_token}/',
    'Changes a template. Body: name, lang, observers, first_signer, folder_path, redirect_link.'),
  write('update_template_form', 'POST', '/api/v1/templates/update-form/',
    'Sets the form a template asks its signer to fill. Body: template_id, inputs[], custom_intro, youtube_video_code.'),
  write('delete_template', 'DELETE', '/api/v1/templates/{template_token}/',
    'Deletes a template. It cannot be undone.', { ...NO_BODY, destructive: true }),
  write('create_webhook', 'POST', '/api/v1/user/company/webhook/',
    'Registers a webhook and saves the id it returns to the webhook registry kept for the user, since ZapSign has no request that lists webhooks and the id is the only way to delete one later. Body: url, type, and optionally doc_token and headers[].'),
  write('delete_webhook', 'DELETE', '/api/v1/user/company/webhook/delete/',
    'Deletes a webhook. Body: id.', { destructive: true }),
  write('create_webhook_header', 'POST', '/api/v1/user/company/webhook/header/',
    'Adds headers to a webhook. Body: id of the webhook, headers[].'),
  write('delete_webhook_header', 'DELETE', '/api/v1/user/company/webhook/header/delete/',
    'Deletes a header of a webhook. Body: id of the header.', { destructive: true }),
  write('create_user', 'POST', '/api/v1/users/create-user',
    'Adds a user to the organization, if it has a seat left; never as owner. Body: email, role, first_name, last_name, phone_country, phone_number.'),
  write('delete_user', 'DELETE', '/api/v1/users/{user_email}/',
    'Removes a user from the organization; the documents they created stay. An owner cannot be removed.', { ...NO_BODY, destructive: true }),
  write('create_background_check', 'POST', '/api/v1/checks/',
    'Starts a background check of a person or a company (identity, criminal records, credit history) in BR, CO, CL, MX or PE. Each check is billed. Body: country, type (person, company, credit_person_br, credit_company_co, …), user_authorized, and the id that type needs (national_id, tax_id, …). The answer shows who was checked; the ids stay in the log.'),
  write('create_partner_account', 'POST', '/api/v1/partner/company/',
    'Partner API: creates a client account under a reseller. Body: email, country, lang, company_name, phone_country, phone_number.'),
  write('update_partner_payment_status', 'POST', '/api/v1/partner/update-payment-status/',
    'Partner API: blocks or unblocks a client account. Body: client_api_token, payment_status.', { destructive: true }),
];

const reads = (tool) => tool.method === 'GET';
const pathNames = (tool) => [...tool.template.matchAll(/\{(\w+)\}/g)].map((found) => found[1]);
function properties(tool) {
  const result = {};
  for (const name of pathNames(tool)) result[name] = IN_PATH[name];
  Object.assign(result, tool.query);
  if (tool.upload) result.file_path = { type: 'string', description: 'Absolute path of the PDF on this computer' };
  if (tool.body === 'required') result.body = { type: 'object', description: 'The JSON body of the request, sent to ZapSign as it is' };
  return result;
}
const required = (tool) => [...pathNames(tool), ...(tool.upload ? ['file_path'] : []), ...(tool.body === 'required' ? ['body'] : [])];

// What a client is told about a tool. A tool that is not a read carries the mark that makes
// Claude Code ask on every call, whatever its permission mode.
const definition = (tool) => ({
  name: tool.name,
  description: reads(tool) ? tool.description : `${tool.description} Runs only after the user approves the call.`,
  inputSchema: { type: 'object', properties: properties(tool), required: required(tool), additionalProperties: false },
  annotations: reads(tool) ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: Boolean(tool.destructive) },
  ...(reads(tool) ? {} : { _meta: { 'anthropic/requiresUserInteraction': true } }),
});

const failure = (text) => ({ content: [{ type: 'text', text }], isError: true });

// What is wrong with the arguments of a call, or null. Nothing a tool does not document is
// ever passed on to ZapSign.
function problem(tool, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'the arguments must be an object';
  const rules = properties(tool);
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(rules, name)) return `'${name}' is not an argument of ${tool.name}`;
  }
  for (const name of required(tool)) {
    if (args[name] === undefined) return `'${name}' is missing`;
  }
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const rule = rules[name];
    if (rule.type === 'integer' && !(Number.isInteger(value) && value >= (rule.minimum ?? value))) {
      return `'${name}' must be a whole number, ${rule.minimum} or more`;
    }
    if (rule.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
      return `'${name}' must be an object`;
    }
    if (rule.type === 'string') {
      if (typeof value !== 'string') return `'${name}' must be text`;
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
        return `'${name}' is not ${rule.pattern === EMAIL_ADDRESS ? 'an email address' : 'a token (letters, digits and hyphens)'}`;
      }
      if (rule.enum && !rule.enum.includes(value)) return `'${name}' must be one of: ${rule.enum.join(', ')}`;
    }
  }
  return null;
}

// What keeps a file from being sent, or null.
function unfitFile(file) {
  if (!path.isAbsolute(file)) return 'the file must be given by its absolute path';
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return 'there is no such file';
  }
  if (!stat.isFile()) return 'that path is not a file';
  if (path.extname(file).toLowerCase() !== '.pdf') return 'the file must be a PDF';
  if (stat.size > MAX_UPLOAD_BYTES) return `the file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
  return null;
}

const keychainKey = (item) => execFileSync(
  'security', ['find-generic-password', '-s', item, '-a', os.userInfo().username, '-w'],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
);
// The key of an environment: its own variable when the client sets one, else, on macOS, its
// Keychain item. Another environment's variable is never used.
const keyFor = (settings, env = process.env, platform = process.platform, keychain = keychainKey) => {
  if (env[settings.variable]) return env[settings.variable];
  return platform === 'darwin' ? keychain(settings.keychain) : '';
};

function createServer({ environment, fetch, readKey, logRoot, now }) {
  if (!Object.hasOwn(ENVIRONMENTS, environment)) throw new Error(`unknown environment '${environment}'`);
  const settings = ENVIRONMENTS[environment];

  // Who is on the other end, as it said in `initialize`. Claude Code asks the user before a
  // tool that carries the asks-first mark or matches an ask rule; another client has neither,
  // so it is offered the reads only and a write it calls anyway is refused.
  let client = '';
  const asksFirst = () => client === 'claude-code';
  // A write is offered only when this environment is not read-only and the client is Claude
  // Code (which asks the user before each such call). Prod is read-only.
  const writesAllowed = () => !settings.readOnly && asksFirst();

  // One request. A GET that ZapSign redirects within its own host (a missing final slash) is
  // asked once more; a redirect to anywhere else is not followed, so the key stays with its
  // host. Anything that is not a GET is sent once and never again: its redirect is an error.
  async function send(method, url, key, payload) {
    const headers = { Authorization: `Bearer ${key}` };
    let body;
    if (payload instanceof FormData) {
      body = payload;
    } else if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(payload);
    }
    const init = { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
    const first = await fetch(url, init);
    if (first.status < 300 || first.status >= 400) return first;
    if (method !== 'GET') throw new Error(`ZapSign answered ${first.status}, a redirect; a request that changes something is never sent again`);
    const location = first.headers.get('location');
    if (!location) return first;
    const next = new URL(location, url);
    if (next.origin !== settings.host) throw new Error('ZapSign redirected to another host; not followed');
    return fetch(next.href, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  // The full answer, for the user: one line per call in the day's file of this environment.
  function record(tool, args, status, response) {
    const at = now();
    const dir = path.join(logRoot, settings.logDir);
    const file = path.join(dir, `${at.toISOString().slice(0, 10)}.jsonl`);
    const id = crypto.randomBytes(4).toString('hex');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fs.appendFileSync(file, `${JSON.stringify({ time: at.toISOString(), id, tool, arguments: args, status, response })}\n`, { mode: 0o600 });
      const oldest = new Date(at.getTime() - LOG_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (const name of fs.readdirSync(dir)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < oldest) fs.unlinkSync(path.join(dir, name));
      }
      return `Fields marked [hidden] are not shown here. The full answer is kept in the user's log, entry ${id}.`;
    } catch (error) {
      return `Fields marked [hidden] are not shown here. The full answer could not be saved to the user's log (${error.code || error.name}).`;
    }
  }

  // A webhook is deleted by the id ZapSign gives when it is created, and nothing lists
  // webhooks. So each created webhook's id goes into webhooks.jsonl, whose name is not a date
  // and so outlives the 30-day pruning: one line per webhook, the id always recoverable.
  function rememberWebhook(body) {
    const id = body !== null && typeof body === 'object' ? body.id : undefined;
    if (id === undefined || id === null) return '\n\nZapSign returned no id for this webhook; without one it cannot be deleted later.';
    const dir = path.join(logRoot, settings.logDir);
    const file = path.join(dir, 'webhooks.jsonl');
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      fs.appendFileSync(file, `${JSON.stringify({ time: now().toISOString(), id, url: body.url, type: body.type })}\n`, { mode: 0o600 });
      return `\n\nWebhook id ${id} saved to the user's webhook registry — delete it later with delete_webhook { "id": ${id} }.`;
    } catch (error) {
      return `\n\nWebhook id ${id} could NOT be saved to the registry (${error.code || error.name}); write it down to be able to delete it later.`;
    }
  }

  async function callTool(params) {
    const tool = TOOLS.find((candidate) => candidate.name === params.name);
    if (!tool) return failure(`There is no tool '${params.name}' here.`);
    if (!reads(tool) && !writesAllowed()) {
      return failure(settings.readOnly
        ? `${tool.name} changes something at ZapSign, and this ${environment} server is read-only; only the reads are available.`
        : `${tool.name} is not a read, so it is offered only to Claude Code, which asks the user before each such call. From this client only the reads are available.`);
    }
    const args = params.arguments === undefined ? {} : params.arguments;
    const wrong = problem(tool, args) || (tool.upload ? unfitFile(args.file_path) : null);
    if (wrong) return failure(`${tool.name}: ${wrong}.`);

    let key = '';
    try {
      key = String(readKey(settings)).trim();
    } catch {
      key = '';
    }
    if (!key) {
      return failure(`There is no key for ${environment}. Set ${settings.variable} in this server's environment, or on macOS store it once in the Keychain with: security add-generic-password -s ${settings.keychain} -a "$USER" -w`);
    }

    const route = tool.template.replace(/\{(\w+)\}/g, (_, name) => encodeURIComponent(args[name]));
    const search = new URLSearchParams();
    for (const name of Object.keys(tool.query)) {
      if (args[name] !== undefined) search.set(name, String(args[name]));
    }
    const query = search.toString();
    const url = `${settings.host}${route}${query ? `?${query}` : ''}`;
    let payload = args.body;
    if (tool.upload) {
      payload = new FormData();
      payload.append('file', new Blob([fs.readFileSync(args.file_path)], { type: 'application/pdf' }), path.basename(args.file_path));
    }
    // Should ZapSign ever echo the key, it is taken out of what is answered and kept. A real
    // key is long; a short one would only chop ordinary words.
    const withoutKey = (text) => (key.length < 8 ? text : text.split(key).join('[key]'));

    let status;
    let text;
    try {
      const response = await send(tool.method, url, key, payload);
      status = response.status;
      text = withoutKey(await response.text());
    } catch (error) {
      const why = withoutKey(error.message);
      if (reads(tool)) return failure(`ZapSign (${environment}) could not be asked: ${why}`);
      // A write that got no answer may already have left: it is kept, so nobody sends it
      // again without looking first.
      const kept = record(tool.name, args, null, why);
      return failure(`${tool.name} got no answer from ZapSign (${environment}): ${why}. It may have reached ZapSign all the same: check with a read before sending it again.\n\n${kept}`);
    }
    const fine = status >= 200 && status < 300;
    if (text.trim() === '') {
      const kept = record(tool.name, args, status, null);
      const said = `ZapSign (${environment}) answered ${status} with no content.\n\n${kept}`;
      return fine ? { content: [{ type: 'text', text: said }] } : failure(said);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      const kept = record(tool.name, args, status, text);
      // A CSV is the answer of a tool that asks for one: its documented columns are shown.
      if (tool.csv && fine) return { content: [{ type: 'text', text: `${filterCsv(text)}\n\n${kept}` }] };
      // Any other text is not shown. A 2xx still means it was done: a write is not to be sent again.
      const said = `ZapSign (${environment}) answered ${status} with something that is not JSON.\n\n${kept}`;
      return fine ? { content: [{ type: 'text', text: said }] } : failure(said);
    }
    const kept = record(tool.name, args, status, body);
    if (!fine) return failure(`ZapSign (${environment}) answered ${status}: ${JSON.stringify(filter(body, { error: true }))}\n\n${kept}`);
    const note = tool.name === 'create_webhook' ? rememberWebhook(body) : '';
    return { content: [{ type: 'text', text: `${JSON.stringify(filter(body), null, 2)}${note}\n\n${kept}` }] };
  }

  const methods = {
    initialize: (params) => {
      client = params.clientInfo && typeof params.clientInfo.name === 'string' ? params.clientInfo.name : '';
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: `zapsign-${environment}`, version: '2.0.0' },
      };
    },
    ping: () => ({}),
    'tools/list': () => ({ tools: TOOLS.filter((tool) => reads(tool) || writesAllowed()).map(definition) }),
    'tools/call': callTool,
  };

  async function handle(message) {
    const valid = message !== null && typeof message === 'object' && !Array.isArray(message) && typeof message.method === 'string';
    if (!valid) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    if (!('id' in message)) return null;
    const method = methods[message.method];
    if (!method) return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    try {
      return { jsonrpc: '2.0', id: message.id, result: await method(message.params || {}) };
    } catch (error) {
      return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } };
    }
  }

  return { handle };
}

function main(argv) {
  const environment = argv[2];
  if (!Object.hasOwn(ENVIRONMENTS, environment || '')) {
    process.stderr.write('usage: zapsign-mcp sandbox|prod\n');
    process.exit(2);
  }
  const server = createServer({
    environment,
    fetch: globalThis.fetch,
    readKey: (settings) => keyFor(settings),
    logRoot: logRootFor(process.env, os.homedir()),
    now: () => new Date(),
  });
  const send = (answer) => { if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`); };
  readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    server.handle(message).then(send);
  });
}

module.exports = { createServer, keychainKey, keyFor, logRootFor, ENVIRONMENTS, TOOLS };
if (require.main === module) main(process.argv);
