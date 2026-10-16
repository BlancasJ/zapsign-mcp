'use strict';
// response-filter — what an agent is shown of a ZapSign answer. zapsign-mcp keeps the whole
// answer in the user's log and hands the agent this filtered copy.
//
// The agent sees what one debugs with: tokens, states, dates, the settings of documents and
// templates, and who is involved (names, emails, the number of an identity document). It never
// sees tax or population ids (CPF, CNPJ, RFC, CURP and the like), dates of birth, photos and
// signature images, signing or file links, IP addresses or location, a whole phone number, what
// a signer typed into a form, what a background check found, or the value of a webhook header.
//
// SHOWN lists the keys the agent may see, not the ones it may not: a key ZapSign adds tomorrow,
// or one its documentation never showed, keeps its name and shows [hidden], so the agent can
// still say that the log holds it. Every text that is shown has its links, IP addresses and tax
// ids masked by their shape. true, false and null always pass: they say how something is set,
// not who someone is.
const HIDDEN = '[hidden]';

const SHOWN = new Set([
  // Tokens and ids
  'token', 'id', 'open_id', 'doc_token', 'signer_token', 'template_id', 'user_token', 'parent_doc_token', 'folder_token',
  'check_id', 'database_id', 'process_id', 'validation_number', 'external_id',
  // How it went
  'status', 'status_code', 'result', 'severity', 'success', 'score', 'reason', 'rejected_reason',
  'authentication_failure_reason', 'identity_state', 'identity_result', 'payment_status', 'event', 'event_type',
  'description', 'type', 'check_type', 'data_set', 'database_name', 'route', 'depth', 'selfie_validation_type',
  'auth_mode', 'created_through', 'notification_channel', 'notification_type', 'send_via', 'qualification', 'role',
  'code', 'detail', 'message', 'error', 'non_field_errors',
  // When
  'created_at', 'last_update_at', 'update_date', 'signed_at', 'last_view_at', 'deleted_at', 'sent_at', 'time',
  'expiration_date', 'date_limit_to_sign', 'signingDate', 'current_period_end', 'timezone',
  // Counts, pages and order
  'count', 'next', 'previous', 'self', 'page', 'order', 'order_group', 'total_signers', 'failed_count', 'sent_count',
  'attempts_used', 'max_attempts', 'times_viewed', 'minimum_signatures_required', 'reminder_every_n_days',
  'auto_reminder', 'sms', 'whatsapp', 'credits', 'credits_balance', 'number_of_credits', 'period', 'plan_name',
  'document_display_order', 'failed_signers',
  // Who is involved: debugging needs these
  'name', 'first_name', 'last_name', 'full_name', 'found_first_name', 'found_last_name', 'company_name',
  'found_company_name', 'brand_name', 'email', 'user', 'username', 'created_by', 'observers', 'notify_extra_emails',
  'document_number', 'document_type', 'document_country', 'country', 'native_country', 'region', 'lang',
  'commonName', 'authority', 'phone_country',
  // Documents, templates and their forms
  'folder_path', 'redirect_link', 'custom_message', 'custom_intro', 'brand_primary_color', 'brand_logo',
  'signature_anchor_text', 'rubrica_anchor_text', 'relative_position_bottom', 'relative_position_left',
  'relative_size_x', 'relative_size_y', 'template_type', 'youtube_video_code', 'title', 'label', 'variable',
  'input_type', 'help_text', 'options', 'key', 'value', 'tsa_country',
  // Files: their links are masked to the host
  'signed_file', 'original_file', 'url', 'url_pdf', 'docx_url', 'template_file',
]);
// A key that is shown elsewhere and hidden here: what a signer typed into a template's form,
// what a database of a background check found, and a webhook header's value (often a secret).
const HIDDEN_UNDER = { answers: 'value', cells: 'value', headers: 'value' };
const PHONES = new Set(['phone_number', 'phone']);
// A link to the next or previous page is shown whole when it points at ZapSign's own API, so
// the agent can ask for that page; any other link there is masked like the rest.
const PAGING = new Set(['next', 'previous', 'self']);
const API_LINK = /^(?:https?:\/\/(?:sandbox\.)?api\.zapsign\.com\.br)?\/api\//i;
// The columns of the partners CSV, as ZapSign documents them. Any other column keeps its name
// and shows [hidden].
const CSV_COLUMNS = new Set([
  'id', 'name', 'brand_name', 'plan_name', 'credits', 'status', 'period', 'current_period_end', 'documents_created',
  'envelopes_created', 'qty_sms', 'qty_whatsapp', 'qty_digital_certificate', 'qty_biometry_sov', 'qty_facial_recognition',
  'qty_identity_verification', 'qty_liveness',
]);

const LINK = /\b(?:https?:\/\/|data:)[^\s"'<>]+/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// Five groups or more, or a "::": a time of day such as 10:00:00 is not an address.
const IPV6 = /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b|\b(?:[0-9a-f]{1,4}:)+:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?/gi;
// A tax or population id is masked wherever it is written, also glued to a word
// (Contrato_123.456.789-09): only a digit, or a letter for CURP and RFC, may not touch it.
const CNPJ = /(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g;
const CPF = /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g;
const CURP = /(?<![A-Z0-9])[A-Z]{4}\d{6}[HMX][A-Z]{5}[A-Z0-9]\d(?![A-Z0-9])/g;
const RFC = /(?<![A-ZÑ&0-9])[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}(?![A-Z0-9])/g;
// Written without dots: 14 digits (a CNPJ) or 11 (a CPF), alone. An 11-digit Brazilian mobile
// number written in a text is masked as well, which the rule for phones wants anyway.
const CNPJ_BARE = /(?<!\d)\d{8}\/?\d{4}-?\d{2}(?!\d)/g;
const CPF_BARE = /(?<!\d)\d{9}-?\d{2}(?!\d)/g;
// In an error, a text in a list is shown when it reads as a message ("CPF inválido"): two
// words of letters, and no run of three digits (a date, an id, a number in an address).
const readsAsMessage = (text) => /\p{L}{2,}\s+\p{L}{2,}/u.test(text) && !/\d{3}/.test(text);

const maskLink = (link) => {
  try {
    const { protocol, host } = new URL(link);
    return protocol === 'data:' ? HIDDEN : `[url: ${host}]`;
  } catch {
    return HIDDEN;
  }
};
const maskPhone = (phone) => (phone.replace(/\D/g, '').length > 4 ? `${'*'.repeat(6)}${phone.replace(/\D/g, '').slice(-4)}` : phone);

// An IP address goes before the ids, so 192.168.001.002 is not read as part of a CPF.
function maskShapes(text, links = true) {
  const linked = links ? text.replace(LINK, maskLink) : text;
  return linked.replace(IPV4, '[ip]').replace(IPV6, '[ip]').replace(CNPJ, '[cnpj]').replace(CPF, '[cpf]')
    .replace(CNPJ_BARE, '[number]').replace(CPF_BARE, '[number]').replace(CURP, '[curp]').replace(RFC, '[rfc]');
}

// A text of an error's list: what ZapSign says is wrong with a field.
function message(text, key) {
  if (PHONES.has(key)) return maskPhone(text);
  return SHOWN.has(key) || readsAsMessage(text) ? maskShapes(text) : HIDDEN;
}

function walk(value, key, parent, error) {
  if (value === null || value === '') return value;
  // Hidden whole, whatever it holds: a list or an object here is not looked into.
  if (HIDDEN_UNDER[parent] === key) return HIDDEN;
  if (Array.isArray(value)) {
    return value.map((item) => (error && typeof item === 'string' ? message(item, key) : walk(item, key, parent, error)));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, walk(inner, name, key, error)]));
  }
  if (typeof value === 'boolean') return value;
  // A bare text or number is a message, not a record.
  if (key === '') return typeof value === 'string' ? maskShapes(value) : value;
  if (PHONES.has(key)) return maskPhone(String(value));
  if (!SHOWN.has(key)) return HIDDEN;
  if (typeof value !== 'string') return value;
  return maskShapes(value, !(PAGING.has(key) && API_LINK.test(value)));
}

// The copy of an answer that the agent is shown. An error answer goes through the same filter;
// only the messages in it stay readable.
const filter = (body, { error = false } = {}) => walk(body, '', '', error);

// A CSV: quoted fields may hold commas, quotes and line ends.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
const quote = (field) => (/[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field);

// The partners CSV: the documented columns, masked by shape; any other column by name only.
function filterCsv(text) {
  const [header = [], ...rows] = parseCsv(text);
  const shown = rows.map((row) => row.map((field, i) => (
    field === '' || CSV_COLUMNS.has(header[i]) ? maskShapes(field) : HIDDEN)));
  return [header.map((name) => maskShapes(name)), ...shown].map((row) => row.map(quote).join(',')).join('\n');
}

module.exports = { filter, filterCsv, maskShapes, HIDDEN, SHOWN };
