'use strict';
// Cases for bin/zapsign-mcp.js. Nothing here reaches ZapSign or the Keychain:
// the server is built with stand-ins for both, and its log goes to a temporary folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'bin', 'zapsign-mcp.js');
const { createServer, ENVIRONMENTS } = require(SERVER);

const refuse = () => { throw new Error('must not be called'); };
const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const quiet = (over = {}) => createServer({
  environment: 'sandbox', fetch: refuse, readKey: refuse, logRoot: temp('zs-'),
  now: () => new Date('2026-10-09T12:00:00Z'), ...over,
});
const call = (server, method, params, id = 1) => server.handle({ jsonrpc: '2.0', id, method, params });

test('initialize names the server after its environment and offers tools', async () => {
  const r = await call(quiet(), 'initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.equal(r.result.serverInfo.name, 'zapsign-sandbox');
  assert.deepEqual(r.result.capabilities, { tools: {} });
});

test('a protocol version it does not know is answered with the newest it knows', async () => {
  const r = await call(quiet(), 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(r.result.protocolVersion, '2025-06-18');
});

test('listing tools reaches neither ZapSign nor the Keychain', async () => {
  const r = await call(quiet(), 'tools/list');
  assert.ok(r.result.tools.length >= 6);
});

test('a notification gets no answer, ping gets an empty one, an unknown method -32601', async () => {
  assert.equal(await quiet().handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await call(quiet(), 'ping')).result, {});
  assert.equal((await call(quiet(), 'nope')).error.code, -32601);
});

test('started in an empty folder it answers, survives a broken line and leaves the folder empty', () => {
  const cwd = temp('zs-cwd-');
  const input = `not json\n${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`;
  const run = spawnSync(process.execPath, [SERVER, 'sandbox'], { cwd, input, encoding: 'utf8' });
  const lines = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].error.code, -32700);
  assert.equal(lines[1].id, 7);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('an environment that is not sandbox or prod is refused with the usage', () => {
  const run = spawnSync(process.execPath, [SERVER, 'staging'], { input: '', encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: zapsign-mcp sandbox\|prod/);
});

test('each environment has its own host, key variable, Keychain item and log folder', () => {
  assert.equal(ENVIRONMENTS.sandbox.host, 'https://sandbox.api.zapsign.com.br');
  assert.equal(ENVIRONMENTS.prod.host, 'https://api.zapsign.com.br');
  assert.equal(ENVIRONMENTS.sandbox.variable, 'ZAPSIGN_SANDBOX_TOKEN');
  assert.equal(ENVIRONMENTS.prod.variable, 'ZAPSIGN_PROD_TOKEN');
  assert.equal(ENVIRONMENTS.sandbox.keychain, 'zapsign-mcp-sandbox');
  assert.equal(ENVIRONMENTS.prod.keychain, 'zapsign-mcp-prod');
  assert.equal(ENVIRONMENTS.sandbox.logDir, 'sandbox');
  assert.equal(ENVIRONMENTS.prod.logDir, 'prod');
});

test('the log lives in the XDG state folder, or in ~/.local/state when none is set', () => {
  const { logRootFor } = require(SERVER);
  assert.equal(logRootFor({ XDG_STATE_HOME: '/x/state' }, '/h'), '/x/state/zapsign-mcp');
  assert.equal(logRootFor({}, '/h'), '/h/.local/state/zapsign-mcp');
  assert.equal(logRootFor({ XDG_STATE_HOME: 'not/absolute' }, '/h'), '/h/.local/state/zapsign-mcp');
});

const DOC_TOKEN = '0f8fad5b-d9cb-469f-a165-70867728950e';
const CHECK_ID = 'CHK41dd253a3e9c018f3d4ee062ac98b091';
const reply = (status, body, type = 'application/json') => async () => new Response(
  typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } },
);
const tool = (server, name, args) => call(server, 'tools/call', { name, arguments: args });
const asking = (environment = 'sandbox') => {
  const asked = [];
  const server = quiet({
    environment,
    readKey: () => 'k',
    fetch: async (url, init) => { asked.push(`${init.method} ${url}`); return reply(200, {})(); },
  });
  return { server, asked };
};

test('a read asks its own host once, with the key of its environment', async () => {
  const seen = [];
  const server = quiet({
    environment: 'prod',
    readKey: (settings) => { seen.push(settings.variable); return 'k-123\n'; },
    fetch: async (url, init) => { seen.push(url, init.method, init.headers.Authorization); return reply(200, { token: 'abc' })(); },
  });
  await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.deepEqual(seen, ['ZAPSIGN_PROD_TOKEN', `https://api.zapsign.com.br/api/v1/docs/${DOC_TOKEN}/`, 'GET', 'Bearer k-123']);
});

test('without a key nothing is sent and the answer says how to give one', async () => {
  const server = quiet({ readKey: () => { throw new Error('not found'); } });
  const r = await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /ZAPSIGN_SANDBOX_TOKEN/);
  assert.match(r.result.content[0].text, /security add-generic-password -s zapsign-mcp-sandbox/);
});

test('an answer that is not JSON comes back as an error with its status and no body', async () => {
  const server = quiet({ readKey: () => 'k', fetch: reply(404, '<html>ana@example.com</html>', 'text/html') });
  const r = await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /404/);
  assert.ok(!r.result.content[0].text.includes('ana@example.com'));
});

test('a write ZapSign answers 2xx with text that is not JSON is reported as done, without the text', async () => {
  const server = await claude({ readKey: () => 'k', fetch: reply(200, 'Documento reprocessado com sucesso 123.456.789-09', 'text/plain') });
  const r = await tool(server, 'reprocess_document', { doc_token: DOC_TOKEN, body: { send_webhook: true } });
  assert.equal(r.result.isError, undefined);
  assert.match(r.result.content[0].text, /200/);
  assert.ok(!r.result.content[0].text.includes('123.456.789-09'));
});

test('a request that cannot be made comes back as an error, not as a crash', async () => {
  const server = quiet({ readKey: () => 'k', fetch: async () => { throw new TypeError('fetch failed'); } });
  const r = await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /fetch failed/);
});

const READS = [
  ['get_document', { doc_token: DOC_TOKEN }, `/api/v1/docs/${DOC_TOKEN}/`],
  ['list_documents', { page: 2, status: 'signed', sort_order: 'desc' }, '/api/v1/docs/?page=2&status=signed&sort_order=desc'],
  ['get_document_audit_trail', { doc_token: DOC_TOKEN }, `/api/v1/docs/signer-log/${DOC_TOKEN}`],
  ['get_signer', { signer_token: DOC_TOKEN }, `/api/v1/signers/${DOC_TOKEN}/`],
  ['list_templates', { page: 3 }, '/api/v1/templates/?page=3'],
  ['get_template', { template_token: DOC_TOKEN }, `/api/v1/templates/${DOC_TOKEN}/`],
  ['get_signer_validations', { signer_token: DOC_TOKEN }, `/api/v1/signer-verification-details/${DOC_TOKEN}/`],
  ['get_plan', {}, '/api/v1/info-plan/'],
  ['list_users', { page: 2 }, '/api/v1/users/?page=2'],
  ['get_partner_plans_csv', { start_date: '2026-10-01', end_date: '2026-10-09' }, '/api/v1/info-plan/partners-csv/?start_date=2026-10-01&end_date=2026-10-09'],
  ['get_background_check', { check_id: CHECK_ID }, `/api/v1/checks/${CHECK_ID}/`],
  ['get_background_check_details', { check_id: CHECK_ID, lang: 'pt-br', start_key: 'DTL2' }, `/api/v1/checks/${CHECK_ID}/details/?lang=pt-br&start_key=DTL2`],
];
for (const [name, args, expected] of READS) {
  test(`${name} is one GET to ${expected.split('?')[0].replace(DOC_TOKEN, '{token}')}`, async () => {
    const { server, asked } = asking();
    const r = await tool(server, name, args);
    assert.equal(r.result.isError, undefined);
    assert.deepEqual(asked, [`GET https://sandbox.api.zapsign.com.br${expected}`]);
  });
}

test('a client that has not said it is Claude Code is offered the reads and nothing else', async () => {
  const { tools } = (await call(quiet(), 'tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), READS.map(([name]) => name).sort());
  assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
});

for (const bad of ['../../user/company/webhook', 'a/b', 'abcdefgh?x=1', 'abcdefgh#x', '', 42, undefined]) {
  test(`a token such as ${JSON.stringify(bad)} is refused before any request`, async () => {
    const r = await tool(quiet(), 'get_document', { doc_token: bad });
    assert.equal(r.result.isError, true);
  });
}

test('an argument the tool does not document is refused, not passed on', async () => {
  const r = await tool(quiet(), 'list_documents', { page: 2, download_pdf: true });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /download_pdf/);
});

test('an argument of the wrong kind is refused before any request', async () => {
  assert.equal((await tool(quiet(), 'list_documents', { page: 'two' })).result.isError, true);
  assert.equal((await tool(quiet(), 'list_documents', { status: 'deleted' })).result.isError, true);
});

test('an unknown tool is an error, not a request', async () => {
  assert.equal((await tool(quiet(), 'no_such_tool', { doc_token: DOC_TOKEN })).result.isError, true);
});

test('the Keychain is asked for the item, for this user, and only its output is the key', () => {
  const bin = temp('zs-bin-');
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho "$*"\n', { mode: 0o755 });
  const { keychainKey } = require(SERVER);
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try {
    assert.equal(keychainKey('zapsign-mcp-sandbox').trim(),
      `find-generic-password -s zapsign-mcp-sandbox -a ${os.userInfo().username} -w`);
  } finally {
    process.env.PATH = before;
  }
});

// The key comes from the variable of its environment when the client sets one, else from the
// Keychain on macOS; elsewhere there is no Keychain to ask.
test('the variable of the environment gives the key, before the Keychain', () => {
  const { keyFor } = require(SERVER);
  assert.equal(keyFor(ENVIRONMENTS.sandbox, { ZAPSIGN_SANDBOX_TOKEN: 'v-1' }, 'darwin', refuse), 'v-1');
  assert.equal(keyFor(ENVIRONMENTS.prod, { ZAPSIGN_PROD_TOKEN: 'v-2' }, 'linux', refuse), 'v-2');
});

test('the variable of the other environment is never used', () => {
  const { keyFor } = require(SERVER);
  assert.equal(keyFor(ENVIRONMENTS.prod, { ZAPSIGN_SANDBOX_TOKEN: 'v-1' }, 'linux', refuse), '');
  assert.equal(keyFor(ENVIRONMENTS.prod, { ZAPSIGN_SANDBOX_TOKEN: 'v-1' }, 'darwin', (item) => `kc:${item}`), 'kc:zapsign-mcp-prod');
});

test('without the variable, macOS asks the Keychain for the item of the environment and other systems ask nothing', () => {
  const { keyFor } = require(SERVER);
  assert.equal(keyFor(ENVIRONMENTS.sandbox, {}, 'darwin', (item) => `kc:${item}`), 'kc:zapsign-mcp-sandbox');
  assert.equal(keyFor(ENVIRONMENTS.sandbox, { ZAPSIGN_SANDBOX_TOKEN: '' }, 'linux', refuse), '');
});

const redirect = (location) => async () => new Response(null, { status: 301, headers: { location } });

test('a redirect on the same host is followed once, with the key', async () => {
  const asked = [];
  const server = quiet({
    readKey: () => 'k',
    fetch: async (url, init) => {
      asked.push(`${url} ${init.headers.Authorization} ${init.redirect}`);
      return asked.length === 1 ? redirect(`/api/v1/docs/signer-log/${DOC_TOKEN}/`)() : reply(200, { ok: true })();
    },
  });
  const r = await tool(server, 'get_document_audit_trail', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(asked, [
    `https://sandbox.api.zapsign.com.br/api/v1/docs/signer-log/${DOC_TOKEN} Bearer k manual`,
    `https://sandbox.api.zapsign.com.br/api/v1/docs/signer-log/${DOC_TOKEN}/ Bearer k manual`,
  ]);
});

test('a redirect to another host is not followed', async () => {
  const asked = [];
  const server = quiet({
    readKey: () => 'k',
    fetch: async (url) => { asked.push(url); return redirect('https://elsewhere.example/api/v1/docs/')(); },
  });
  const r = await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.equal(asked.length, 1);
  assert.match(r.result.content[0].text, /another host/);
});

const DOC = {
  token: '0f8fad5b', open_id: 77, status: 'signed', name: 'Contrato 42 ana@example.com', external_id: 'L-42',
  created_at: '2026-10-01T10:00:00Z', signed_file: 'https://zapsign.s3.amazonaws.com/x.pdf?sig=1',
  created_by: { email: 'owner@example.org' },
  signers: [{
    token: 's-1', status: 'signed', signed_at: '2026-10-02T09:00:00Z', name: 'Ana Pérez López',
    email: 'ana@example.com', lock_email: true, blank_phone: false, phone_country: '52', phone_number: '5512345678',
    cpf: '123.456.789-09', documentation: 'PELA800101', sign_url: 'https://app.zapsign.com.br/verificar/s-1',
    ip: '203.0.113.20', geo_latitude: '19.43', geo_longitude: '-99.13', times_viewed: 3,
    selfie_photo_url: 'https://zapsign.s3.amazonaws.com/selfie.jpg', signature_image: 'data:image/png;base64,AAAA',
  }],
};
const answerText = async (server, name = 'get_document', args = { doc_token: DOC_TOKEN }) => (await tool(server, name, args)).result.content[0].text;

// What the agent sees (lib/response-filter.js): who signed and how it went, names, emails and
// the number of an identity document included, since those are what one debugs with; never tax
// or population ids (CPF, CNPJ, RFC, CURP…), dates of birth, photos, signing or file links, location, or a whole phone number. The log keeps everything.
test('the agent sees who signed and how it went, never their tax ids, links, location, photos or whole phone', async () => {
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, DOC) }));
  for (const raw of ['5512345678', '123.456.789-09', 'PELA800101', 'verificar/s-1', 'x.pdf', 'selfie.jpg', 'base64',
    '203.0.113.20', '19.43', '-99.13']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['"status": "signed"', '0f8fad5b', '"open_id": 77', '"token": "s-1"', 'L-42', '2026-10-01T10:00:00Z',
    '2026-10-02T09:00:00Z', 'Contrato 42 ana@example.com', '"name": "Ana Pérez López"', '"email": "ana@example.com"',
    'owner@example.org', '"phone_number": "******5678"', '"lock_email": true', '"blank_phone": false', '"phone_country": "52"',
    '"times_viewed": 3', '"signed_file": "[url: zapsign.s3.amazonaws.com]"', '"cpf": "[hidden]"', '"selfie_photo_url": "[hidden]"',
  ]) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('an IP or a link inside a text is masked, a time is not taken for an address, and an email stays', async () => {
  const body = { description: 'call 2001:db8:85a3:0:0:8a2e:370:7334 or 10.0.0.7, mail bob@example.net, see https://example.com/a/b', created_at: '2026-10-01T10:00:00Z' };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['2001:db8', '10.0.0.7', '/a/b']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['bob@example.net', '[url: example.com]', '2026-10-01T10:00:00Z']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('the link to the next page is shown whole, so the agent can ask for it', async () => {
  const body = { count: 31, next: 'https://api.zapsign.com.br/api/v1/users/?page=2', previous: null, results: [] };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }), 'list_users', {});
  assert.ok(text.includes('"next": "https://api.zapsign.com.br/api/v1/users/?page=2"'), text);
});

test('a field the filter does not know shows its name and hides its value; a webhook header keeps its value to itself', async () => {
  const body = {
    token: 't-1', mother_name: 'JOANA', brand_new_field: 'x-42', nested: { address: 'Av. Reforma 222' }, answered: true, missing: null,
    headers: [{ name: 'Authorization', value: 'Bearer s3cr3t' }],
  };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['JOANA', 'x-42', 'Av. Reforma', 's3cr3t']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['"token": "t-1"', '"mother_name": "[hidden]"', '"brand_new_field": "[hidden]"', '"address": "[hidden]"',
    '"name": "Authorization"', '"answered": true', '"missing": null']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('an error answer is filtered like any other, and its messages stay readable', async () => {
  const body = {
    detail: 'signer 123.456.789-09 already signed', cpf: ['CPF inválido'], email: ['Enter a valid email.'],
    non_field_errors: ['Date range cannot exceed 30 days'], signer: { name: 'Ana', date_of_birth: '1980-01-01' },
  };
  const r = await tool(quiet({ readKey: () => 'k', fetch: reply(400, body) }), 'get_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  const text = r.result.content[0].text;
  assert.match(text, /400/);
  for (const raw of ['123.456.789-09', '1980-01-01']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['CPF inválido', 'Enter a valid email.', 'Date range cannot exceed 30 days', '"name":"Ana"']) {
    assert.ok(text.includes(kept), `${kept} is missing from the answer`);
  }
});

test('in an error, a list shows only texts that read as messages, and a hidden place stays hidden', async () => {
  const body = {
    cpf: ['CPF inválido'], phone_number: ['5511999999999'], date_of_birth: ['1980-01-01'], national_id: ['71423860'],
    address: ['Calle Reforma 222'], answers: [{ value: ['Av. Insurgentes 1'] }], headers: [{ value: ['Bearer s3cr3t'] }],
  };
  const r = await tool(quiet({ readKey: () => 'k', fetch: reply(409, body) }), 'get_signer', { signer_token: DOC_TOKEN });
  const text = r.result.content[0].text;
  for (const raw of ['5511999999999', '1980-01-01', '71423860', 'Calle Reforma', 'Av. Insurgentes', 's3cr3t']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['CPF inválido', '******9999']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('a hidden value stays hidden when ZapSign sends it as an object or a list', async () => {
  const body = {
    answers: [{ variable: 'DOMICILIO', value: { description: 'Av. Reforma 222' } }],
    tables: [{ rows: [{ cells: [{ label: 'Sócios', value: [{ name: 'JOAO SILVA', document_number: '9876543' }] }] }] }],
    headers: [{ name: 'Authorization', value: { value: 'Bearer s3cr3t' } }],
  };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['Av. Reforma', 'JOAO SILVA', '9876543', 's3cr3t']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['"variable": "DOMICILIO"', '"label": "Sócios"', '"name": "Authorization"']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('a link is masked whatever the case of its scheme', async () => {
  const body = { description: 'firme en HTTPS://app.zapsign.com.br/verificar/abc-123 o en Http://x.example/y-9' };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['verificar/abc-123', 'y-9']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  assert.ok(text.includes('[url: app.zapsign.com.br]'));
});

test('a paging link is shown whole only when it points at ZapSign\'s API', async () => {
  const body = {
    next: 'https://zapsign.s3.amazonaws.com/x/selfie.jpg?Signature=abc', self: '/api/v1/checks/CHK1/details/?start_key=DTL2',
    previous: 'https://sandbox.api.zapsign.com.br/api/v1/users/?page=1',
  };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['selfie.jpg', 'Signature=abc']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['"self": "/api/v1/checks/CHK1/details/?start_key=DTL2"', '"previous": "https://sandbox.api.zapsign.com.br/api/v1/users/?page=1"',
    '[url: zapsign.s3.amazonaws.com]']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('a CPF or CNPJ written without dots is masked too, and a shorter document number is not', async () => {
  const body = {
    description: 'Contrato 12345678909 / 123456789-09 / CNPJ 12345678000195 / 12345678/0001-95',
    commonName: 'MARIA SOUZA:12345678909', document_number: '48151623', time: '2024-11-27 17:44:32.117577+00:00',
  };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['12345678909', '123456789-09', '12345678000195', '12345678/0001-95']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['MARIA SOUZA:', '"document_number": "48151623"', '2024-11-27 17:44:32.117577+00:00']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('no tool description says where the log is', async () => {
  const { tools } = (await call(await claude(), 'tools/list')).result;
  for (const listed of tools) {
    for (const where of ['.jsonl', 'state/zapsign', '.local']) assert.ok(!listed.description.includes(where), `${listed.name} names ${where}`);
  }
});

const logged = (root, dir = 'sandbox') => fs.readdirSync(path.join(root, dir)).sort()
  .map((file) => fs.readFileSync(path.join(root, dir, file), 'utf8')).join('');

test('each call leaves the unmasked answer in the log of its environment, closed to others', async () => {
  const root = temp('zs-');
  const text = await answerText(quiet({ logRoot: root, readKey: () => 'k', fetch: reply(200, DOC) }));
  const dir = path.join(root, 'sandbox');
  const entry = JSON.parse(fs.readFileSync(path.join(dir, '2026-10-09.jsonl'), 'utf8').trim());
  assert.equal(entry.response.signers[0].email, 'ana@example.com');
  assert.equal(entry.tool, 'get_document');
  assert.deepEqual(entry.arguments, { doc_token: DOC_TOKEN });
  assert.equal(entry.status, 200);
  assert.equal(entry.time, '2026-10-09T12:00:00.000Z');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, '2026-10-09.jsonl')).mode & 0o777, 0o600);
  // The answer names the entry, for the user, and never where the log is: the agent is not to read it.
  assert.ok(text.includes(entry.id));
  for (const where of [root, '2026-10-09.jsonl', 'state/zapsign-mcp']) assert.ok(!text.includes(where), `${where} is in the answer`);
});

test('a created webhook keeps its id in the registry, and the answer gives the id but not where the registry is', async () => {
  const root = temp('zs-');
  const server = await claude({ logRoot: root, readKey: () => 'k', fetch: reply(200, { id: 4815, url: 'https://hooks.example/zs', type: 'doc_signed' }) });
  const text = (await tool(server, 'create_webhook', { body: BODY })).result.content[0].text;
  const kept = JSON.parse(fs.readFileSync(path.join(root, 'sandbox', 'webhooks.jsonl'), 'utf8').trim());
  assert.equal(kept.id, 4815);
  assert.match(text, /4815/);
  for (const where of [root, 'webhooks.jsonl', 'state/zapsign-mcp']) assert.ok(!text.includes(where), `${where} is in the answer`);
});

test('production keeps its own log folder', async () => {
  const root = temp('zs-');
  await answerText(quiet({ environment: 'prod', logRoot: root, readKey: () => 'k', fetch: reply(200, DOC) }));
  assert.deepEqual(fs.readdirSync(root), ['prod']);
});

test('two calls on the same day are two lines of the same file', async () => {
  const root = temp('zs-');
  const server = quiet({ logRoot: root, readKey: () => 'k', fetch: reply(200, DOC) });
  await answerText(server);
  await answerText(server, 'list_templates', {});
  const lines = logged(root).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.tool), ['get_document', 'list_templates']);
  assert.notEqual(lines[0].id, lines[1].id);
});

test('day files older than 30 days go when a new entry is written; other files stay', async () => {
  const root = temp('zs-');
  const dir = path.join(root, 'sandbox');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['2026-09-01.jsonl', '2026-09-09.jsonl', '2026-09-20.jsonl', 'notes.txt']) fs.writeFileSync(path.join(dir, file), '');
  await answerText(quiet({ logRoot: root, readKey: () => 'k', fetch: reply(200, DOC) }));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-09-09.jsonl', '2026-09-20.jsonl', '2026-10-09.jsonl', 'notes.txt']);
});

test('the key never appears in an answer or in the log', async () => {
  const root = temp('zs-');
  const server = quiet({ logRoot: root, readKey: () => 'SECRET-KEY-9', fetch: reply(401, { detail: 'SECRET-KEY-9 is invalid' }) });
  const r = await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.ok(!JSON.stringify(r).includes('SECRET-KEY-9'));
  assert.ok(!logged(root).includes('SECRET-KEY-9'));
  assert.ok(logged(root).includes('"status":401'));
});

test('an answer still comes back when the log cannot be written, and says so', async () => {
  const root = temp('zs-');
  fs.writeFileSync(path.join(root, 'sandbox'), 'a file where the folder should be');
  const text = await answerText(quiet({ logRoot: root, readKey: () => 'k', fetch: reply(200, DOC) }));
  assert.ok(text.includes('"status": "signed"'));
  assert.match(text, /could not be saved/);
  assert.ok(!text.includes(root), 'the answer says where the log is');
});

test('a call that never reaches ZapSign writes nothing', async () => {
  const root = temp('zs-');
  await tool(quiet({ logRoot: root }), 'get_document', { doc_token: '../x' });
  await tool(quiet({ logRoot: root, readKey: () => { throw new Error('no item'); } }), 'get_document', { doc_token: DOC_TOKEN });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('a request whose id is 0 is answered like any other', async () => {
  assert.deepEqual((await call(quiet(), 'ping', undefined, 0)), { jsonrpc: '2.0', id: 0, result: {} });
});

test('what a signer typed into a form is hidden; what the integration attached stays', async () => {
  const body = {
    answers: [{ variable: 'CURP', value: 'PELA800101HDFRPN08' }, { variable: 'DOMICILIO', value: 'Av. Reforma 222, CDMX' }],
    metadata: [{ key: 'env', value: 'uat' }],
  };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['PELA800101HDFRPN08', 'Av. Reforma']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['"variable": "CURP"', '"key": "env"', '"value": "uat"']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

test('a CPF, CNPJ, CURP or RFC inside a text is masked, also when glued to other text', async () => {
  const body = {
    description: 'Contrato_123.456.789-09 / 987.654.321-00_assinado.pdf / Empresa_12.345.678/0001-95 / CPF111.222.333-44'
      + ' / curp PELA800101HDFRPN08 / rfc PELA800101AB1 / host 192.168.001.002-03',
    created_at: '2026-10-01T10:00:00Z',
  };
  const text = await answerText(quiet({ readKey: () => 'k', fetch: reply(200, body) }));
  for (const raw of ['123.456.789-09', '987.654.321-00', '12.345.678/0001-95', '111.222.333-44', 'PELA800101HDFRPN08',
    'PELA800101AB1', '192.']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['Contrato_', '_assinado.pdf', 'Empresa_', '2026-10-01T10:00:00Z']) assert.ok(text.includes(kept), `${kept} is missing from the answer`);
});

// Identity checks and background checks carry a person's whole record, in shapes the
// documentation shows only in part. The agent sees who was checked, the number of the identity
// document and how each step went; dates of birth, tax and population ids, photos, the report's
// link and what each database found stay hidden, and so does any field nobody listed. The log
// keeps the answer whole, image links and all.
const VALIDATIONS = {
  token: 'sv-1', selfie_validation_type: 'identity-verification-global',
  validations: [
    {
      type: 'Identity verification', validation_number: 'cd461e6a', status: 'failed', reason: 'document_expired',
      created_at: '2026-10-05T18:51:26Z', document_photo_url: 'https://zapsign.s3.amazonaws.com/front.jpg',
      document_verse_photo_url: 'https://zapsign.s3.amazonaws.com/back.jpg', selfie_photo_url: '',
      document_ocr: {
        process_id: 'cd461e6a', name: 'MARIA', last_name: 'SOUZA', document_type: 'ID_CARD', document_number: '48151623',
        date_of_birth: '1980-01-01', document_country: 'BR', mother_name: 'JOANA',
      },
    },
    { type: 'Name validation', status: 'success', reason: '', created_at: '2026-10-05T18:51:27Z' },
  ],
};
const CHECK = {
  check_id: CHECK_ID, status: 'completed', company_name: '', full_name: 'MARIA', last_name: 'SOUZA', date_of_birth: '1980-01-01',
  issue_date: '2001-02-03', national_id: '71423860', passport: 'P1234567', native_national_id: '', pep: '', foreign_id: '',
  tax_id: '', country: 'CO', native_country: '', check_type: 'person', lang: 'en', region: '',
  pdf_report: { status: 'completed', url: 'https://zapsign.s3.amazonaws.com/2026/10/checks/92.pdf?AWSAccessKeyId=AKIA&Signature=x&Expires=1' },
  created_at: '2026-10-05T20:09:47Z', last_update_at: '2026-10-05T20:24:15Z',
};
const CHECK_DETAILS = {
  details: [{
    categorization: [], check_id: CHECK_ID, data_set: 'personal_identity', database_id: 'DBI1',
    database_name: 'Validação de identidade com birô privado', depth: 0, document_type: 'national-id',
    found_company_name: '', found_date_of_birth: '1980-01-01T00:00:00Z', found_first_name: 'MARIA', found_gender: 'F',
    found_last_name: 'SOUZA', found_rfc: '', id: 'DTL1', identity_result: '', identity_state: '', result: 'found',
    route: 'id', severity: 'none', update_date: '2026-10-05T19:42:09Z',
    tables: [{ title: 'Informação pessoal', rows: [{ cells: [
      { label: 'N do CPF', value: '123.456.789-09' }, { label: 'Nome da Mãe', value: 'JOANA' },
    ] }] }],
  }],
  next: '',
};
const HIDDEN_RAW = ['JOANA', '71423860', '1980-01-01', '2001-02-03', 'P1234567', '123.456.789-09', 'front.jpg', 'back.jpg',
  '92.pdf', 'Signature='];
for (const [name, args, body, kept, writes] of [
  ['get_signer_validations', { signer_token: DOC_TOKEN }, VALIDATIONS,
    ['"name": "MARIA"', '"last_name": "SOUZA"', '"document_number": "48151623"', '"status": "failed"', '"reason": "document_expired"',
      '"type": "Name validation"', '"document_type": "ID_CARD"', '"document_country": "BR"', '"date_of_birth": "[hidden]"',
      '"document_photo_url": "[hidden]"', '"selfie_photo_url": ""', '2026-10-05T18:51:26Z']],
  ['get_background_check', { check_id: CHECK_ID }, CHECK,
    ['"full_name": "MARIA"', '"status": "completed"', CHECK_ID, '"check_type": "person"', '"country": "CO"',
      '"national_id": "[hidden]"', '"url": "[url: zapsign.s3.amazonaws.com]"', '2026-10-05T20:24:15Z']],
  ['get_background_check_details', { check_id: CHECK_ID }, CHECK_DETAILS,
    ['"found_first_name": "MARIA"', '"result": "found"', '"severity": "none"', '"label": "N do CPF"', '"value": "[hidden]"',
      '"title": "Informação pessoal"', 'Validação de identidade com birô privado', '"data_set": "personal_identity"', 'DTL1']],
  ['create_background_check', { body: { user_authorized: true, type: 'person', country: 'CO', national_id: '71423860' } },
    CHECK, ['"status": "completed"', CHECK_ID, '"full_name": "MARIA"'], true],
]) {
  test(`${name} shows who and how it went, hides ids, dates of birth, photos and findings, and the log keeps all of it`, async () => {
    const root = temp('zs-');
    const over = { logRoot: root, readKey: () => 'k', fetch: reply(200, body) };
    const server = writes ? await claude(over) : quiet(over);
    const r = await tool(server, name, args);
    assert.equal(r.result.isError, undefined);
    const text = r.result.content[0].text;
    for (const raw of HIDDEN_RAW) assert.ok(!text.includes(raw), `${raw} is in the answer`);
    for (const shown of kept) assert.ok(text.includes(shown), `${shown} is missing from the answer`);
    assert.deepEqual(JSON.parse(logged(root).trim()).response, body);
  });
  test(`${name} hides the same when ZapSign sends the record with an error`, async () => {
    const over = { readKey: () => 'k', fetch: reply(409, body) };
    const r = await tool(writes ? await claude(over) : quiet(over), name, args);
    assert.equal(r.result.isError, true);
    for (const raw of HIDDEN_RAW) assert.ok(!r.result.content[0].text.includes(raw), `${raw} is in the answer`);
  });
}

test('the partners CSV comes back as text, its shapes masked, and whole in the log', async () => {
  const root = temp('zs-');
  const csv = 'id,name,brand_name,plan_name,credits,status\n1,Acme,Acme Firma,Pro,90,paid\n2,Beta,Beta,123.456.789-09,0,no_subscription\n';
  const server = quiet({ logRoot: root, readKey: () => 'k', fetch: reply(200, csv, 'text/csv') });
  const r = await tool(server, 'get_partner_plans_csv', {});
  assert.equal(r.result.isError, undefined);
  assert.ok(r.result.content[0].text.includes('1,Acme,Acme Firma,Pro,90,paid'));
  assert.ok(!r.result.content[0].text.includes('123.456.789-09'));
  assert.equal(JSON.parse(logged(root).trim()).response, csv);
});

test('the partners CSV shows the columns ZapSign documents, and only the names of any others', async () => {
  const csv = 'id,name,brand_name,plan_name,credits,status,phone,owner_birth\n1,"Acme, SA",Acme,Pro,90,paid,5511999999999,1980-01-01\n';
  const r = await tool(quiet({ readKey: () => 'k', fetch: reply(200, csv, 'text/csv') }), 'get_partner_plans_csv', {});
  const text = r.result.content[0].text;
  for (const raw of ['5511999999999', '1980-01-01']) assert.ok(!text.includes(raw), `${raw} is in the answer`);
  for (const kept of ['id,name,brand_name,plan_name,credits,status,phone,owner_birth', '1,"Acme, SA",Acme,Pro,90,paid,[hidden],[hidden]']) {
    assert.ok(text.includes(kept), `${kept} is missing from the answer`);
  }
});

for (const bad of ['../x', 'CHK/1', '']) {
  test(`a check id such as ${JSON.stringify(bad)} is refused before any request`, async () => {
    const r = await tool(quiet(), 'get_background_check', { check_id: bad });
    assert.equal(r.result.isError, true);
    assert.ok(r.result.content[0].text.startsWith('get_background_check: '), r.result.content[0].text);
  });
}

// The variables of a real key are taken out, so that the real command can never reach ZapSign.
const withoutKeys = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^ZAPSIGN_\w*TOKEN$/.test(name)));

test('the real command, with no key variable and none in the Keychain: it says how to store it, sends nothing, writes nothing', () => {
  const home = temp('zs-home-');
  const cwd = temp('zs-cwd-');
  const bin = temp('zs-bin-');
  fs.writeFileSync(path.join(bin, 'security'), '#!/bin/sh\necho "The specified item could not be found in the keychain." >&2\nexit 44\n', { mode: 0o755 });
  const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_document', arguments: { doc_token: DOC_TOKEN } } })}\n`;
  const run = spawnSync(process.execPath, [SERVER, 'prod'], {
    cwd, input, encoding: 'utf8', env: { ...withoutKeys, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  });
  const answers = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  const called = answers.find((answer) => answer.id === 2).result;
  assert.equal(called.isError, true);
  assert.match(called.content[0].text, /ZAPSIGN_PROD_TOKEN/);
  assert.match(called.content[0].text, /security add-generic-password -s zapsign-mcp-prod/);
  assert.equal(run.stderr, '');
  assert.deepEqual(fs.readdirSync(home), []);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

// ── Everything that is not a GET ───────────────────────────────────────────────────────────
// A GET runs freely. Any other request changes something at ZapSign, or sends it a file, and
// runs only after the user approves that very call: Claude Code asks them, and no other client
// is offered those tools.
const { TOOLS } = require(SERVER);
const COLLECTION = require('./zapsign-collection.json').requests;
const DOCUMENTED = require('./zapsign-collection.json').documented;
const SETTINGS = require('../examples/claude-settings.json');
const SERVERS = ['zapsign-sandbox', 'zapsign-prod'];
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const matches = (rule, name) => new RegExp('^' + rule.split('*').map(literal).join('.*') + '$').test(name);
const ruled = (list, name) => (SETTINGS.permissions[list] || []).some((rule) => matches(rule, name));
const hello = (server, clientInfo) => call(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo });
const claude = async (over = {}) => {
  const server = quiet(over);
  await hello(server, { name: 'claude-code', version: '2.1.296' });
  return server;
};

test('the example settings deny the agent\'s file tools the default log folder', () => {
  const { logRootFor } = require(SERVER);
  assert.ok(SETTINGS.permissions.deny.includes(`Read(~/${path.relative('/h', logRootFor({}, '/h'))}/**)`));
});

// Claude Code's Bash sandbox closes what a rule cannot: no program a shell command starts reads
// the log, and no shell command reaches ZapSign's API, even with the key in hand. WebFetch
// runs outside the sandbox, so a rule denies it the API. Commands keep asking as before.
test('the example settings close the log and ZapSign\'s hosts to the sandbox, and the hosts to WebFetch', () => {
  const { logRootFor } = require(SERVER);
  const hosts = Object.values(ENVIRONMENTS).map((settings) => new URL(settings.host).hostname).sort();
  const { sandbox } = SETTINGS;
  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.autoAllowBashIfSandboxed, false);
  assert.deepEqual([...sandbox.network.deniedDomains].sort(), hosts);
  assert.deepEqual(sandbox.filesystem.denyRead, [`~/${path.relative('/h', logRootFor({}, '/h'))}`]);
  for (const host of hosts) assert.ok(SETTINGS.permissions.deny.includes(`WebFetch(domain:${host})`), `WebFetch(domain:${host})`);
});

test('every request of the collection and of the documentation has a tool, and every tool is one of them', () => {
  const served = new Set(TOOLS.map((row) => `${row.method} ${row.template}`));
  const wanted = new Set([...COLLECTION, ...DOCUMENTED].map((request) => `${request.method} ${request.served || request.path}`));
  assert.equal(COLLECTION.length, 37);
  assert.equal(DOCUMENTED.length, 13);
  assert.deepEqual([...wanted].filter((request) => !served.has(request)), []);
  assert.deepEqual([...served].filter((request) => !wanted.has(request)), []);
});

test('a GET is free and anything else asks first: names, marks and the example settings agree, tool by tool', async () => {
  const { tools } = (await call(await claude(), 'tools/list')).result;
  assert.equal(tools.length, TOOLS.length);
  for (const listed of tools) {
    const reads = TOOLS.find((row) => row.name === listed.name).method === 'GET';
    assert.match(listed.name, reads ? /^(get|list)_/ : /^(?!get_|list_|read_)/);
    assert.equal(Boolean(listed._meta && listed._meta['anthropic/requiresUserInteraction'] === true), !reads, `${listed.name}: asks-first mark`);
    assert.equal(listed.annotations.readOnlyHint, reads, `${listed.name}: read-only hint`);
    for (const server of SERVERS) {
      const full = `mcp__${server}__${listed.name}`;
      assert.equal(ruled('allow', full), reads, `${full}: allow rule`);
      assert.equal(ruled('ask', full), !reads, `${full}: ask rule`);
      assert.equal(ruled('deny', full), false, `${full}: deny rule`);
    }
  }
});

for (const client of [undefined, { name: 'cursor-vscode', version: '1' }, { name: 'claude-code-like', version: '1' }, {}]) {
  test(`a client announced as ${JSON.stringify(client && client.name)} can neither see nor call a write`, async () => {
    const server = quiet();
    if (client) await hello(server, client);
    const { tools } = (await call(server, 'tools/list')).result;
    assert.deepEqual(tools.map((listed) => listed.name).sort(), READS.map(([name]) => name).sort());
    const r = await tool(server, 'delete_document', { doc_token: DOC_TOKEN });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Claude Code/);
  });
}

const BODY = { any: 'thing', nested: { n: 1 } };
const WRITES = [
  ['create_document', { body: BODY }, 'POST /api/v1/docs/'],
  ['create_document_async', { body: BODY }, 'POST /api/v1/docs/async/'],
  ['create_document_from_template', { body: BODY }, 'POST /api/v1/models/create-doc/'],
  ['create_document_from_template_async', { body: BODY }, 'POST /api/v1/models/create-doc/async/'],
  ['add_extra_document', { doc_token: DOC_TOKEN, body: BODY }, `POST /api/v1/docs/${DOC_TOKEN}/upload-extra-doc/`],
  ['add_extra_document_from_template', { doc_token: DOC_TOKEN, body: BODY }, `POST /api/v1/models/${DOC_TOKEN}/upload-extra-doc/`],
  ['place_signatures', { doc_token: DOC_TOKEN, body: BODY }, `POST /api/v1/docs/${DOC_TOKEN}/place-signatures/`],
  ['reorder_envelope_documents', { doc_token: DOC_TOKEN, body: BODY }, `PUT /api/v1/docs/${DOC_TOKEN}/document-display-order/`],
  ['resend_notifications', { doc_token: DOC_TOKEN }, `POST /api/v1/docs/${DOC_TOKEN}/resend-notifications-bulk/`],
  ['delete_document', { doc_token: DOC_TOKEN }, `DELETE /api/v1/docs/${DOC_TOKEN}/`],
  ['reject_document', { body: BODY }, 'POST /api/v1/refuse/'],
  ['reject_document_by_user', { body: BODY }, 'POST /api/v1/refuse/by-user/'],
  ['sign_in_batch', { body: BODY }, 'POST /api/v1/sign/'],
  ['add_timestamp', { body: BODY }, 'POST /api/v1/timestamp/'],
  ['add_signer', { doc_token: DOC_TOKEN, body: BODY }, `POST /api/v1/docs/${DOC_TOKEN}/add-signer/`],
  ['update_signer', { signer_token: DOC_TOKEN, body: BODY }, `POST /api/v1/signers/${DOC_TOKEN}/`],
  ['delete_signer', { signer_token: DOC_TOKEN }, `DELETE /api/v1/signer/${DOC_TOKEN}/remove/`],
  ['reset_signer_validation_attempts', { signer_token: DOC_TOKEN }, `PUT /api/v1/reset-auth-attempts/${DOC_TOKEN}/`],
  ['create_template', { body: BODY }, 'POST /api/v1/templates/create'],
  ['update_template', { template_token: DOC_TOKEN, body: BODY }, `PUT /api/v1/templates/${DOC_TOKEN}/`],
  ['update_template_form', { body: BODY }, 'POST /api/v1/templates/update-form/'],
  ['delete_template', { template_token: DOC_TOKEN }, `DELETE /api/v1/templates/${DOC_TOKEN}/`],
  ['create_webhook', { body: BODY }, 'POST /api/v1/user/company/webhook/'],
  ['delete_webhook', { body: BODY }, 'DELETE /api/v1/user/company/webhook/delete/'],
  ['create_webhook_header', { body: BODY }, 'POST /api/v1/user/company/webhook/header/'],
  ['delete_webhook_header', { body: BODY }, 'DELETE /api/v1/user/company/webhook/header/delete/'],
  ['create_partner_account', { body: BODY }, 'POST /api/v1/partner/company/'],
  ['update_partner_payment_status', { body: BODY }, 'POST /api/v1/partner/update-payment-status/'],
  ['update_document', { doc_token: DOC_TOKEN, body: BODY }, `PUT /api/v1/docs/${DOC_TOKEN}/`],
  ['reprocess_document', { doc_token: DOC_TOKEN, body: BODY }, `POST /api/v1/docs/${DOC_TOKEN}/reprocess-doc/`],
  ['create_user', { body: BODY }, 'POST /api/v1/users/create-user'],
  ['delete_user', { user_email: 'ana.perez+zs@example.com' }, 'DELETE /api/v1/users/ana.perez%2Bzs%40example.com/'],
  ['add_timestamp_keeping_signature', { body: BODY }, 'POST /api/v1/timestamp/no-signature'],
  ['delete_signer_groups', { doc_token: DOC_TOKEN }, `DELETE /api/v1/signature-group/${DOC_TOKEN}/`],
  ['create_background_check', { body: BODY }, 'POST /api/v1/checks/'],
];

test('the cases below cover every tool that is not a read', () => {
  assert.deepEqual(TOOLS.filter((row) => row.method !== 'GET').map((row) => row.name).sort(),
    [...WRITES.map(([name]) => name), 'validate_pdf_signature'].sort());
});

for (const [name, args, expected] of WRITES) {
  test(`${name} is one ${expected.replace(DOC_TOKEN, '{token}')}, with its body as it was given`, async () => {
    const seen = [];
    const server = await claude({
      readKey: () => 'k',
      fetch: async (url, init) => { seen.push(`${init.method} ${url}`, init.headers.Authorization, init.redirect, init.headers['Content-Type'], init.body); return reply(200, { ok: true })(); },
    });
    const r = await tool(server, name, args);
    assert.equal(r.result.isError, undefined);
    const [method, route] = expected.split(' ');
    assert.deepEqual(seen, [`${method} https://sandbox.api.zapsign.com.br${route}`, 'Bearer k', 'manual',
      args.body ? 'application/json' : undefined, args.body ? JSON.stringify(BODY) : undefined]);
  });
}

// Production is read-only (readOnly in ENVIRONMENTS). When the flag goes, the case
// "a write in production goes to the production host, with the production key" comes back.
test('production offers Claude Code the reads alone, and a write called anyway reads no key and sends nothing', async () => {
  const seen = [];
  const server = await claude({
    environment: 'prod',
    readKey: (item) => { seen.push(item); return 'k'; },
    fetch: async (url, init) => { seen.push(`${init.method} ${url}`); return reply(200, {})(); },
  });
  const { tools } = (await call(server, 'tools/list')).result;
  assert.deepEqual(tools.map((listed) => listed.name).sort(), READS.map(([name]) => name).sort());
  const r = await tool(server, 'delete_signer', { signer_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /read-only/);
  assert.deepEqual(seen, []);
});

test('a write is never sent twice: a redirect is an error', async () => {
  const asked = [];
  const server = await claude({ readKey: () => 'k', fetch: async (url) => { asked.push(url); return redirect(`/api/v1/docs/${DOC_TOKEN}`)(); } });
  const r = await tool(server, 'delete_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.equal(asked.length, 1);
  assert.match(r.result.content[0].text, /redirect/);
});

for (const [why, name, args] of [
  ['without the body it needs', 'add_signer', { doc_token: DOC_TOKEN }],
  ['with a body that is text', 'add_signer', { doc_token: DOC_TOKEN, body: '{"name":"x"}' }],
  ['with a body that is a list', 'add_signer', { doc_token: DOC_TOKEN, body: [BODY] }],
  ['with a body it does not take', 'delete_document', { doc_token: DOC_TOKEN, body: BODY }],
  ['with a token that carries a path', 'delete_document', { doc_token: '../../user/company/webhook' }],
  ['with an email that carries a path', 'delete_user', { user_email: 'ana/../x@example.com' }],
  ['with an email that is not one', 'delete_user', { user_email: 'ana' }],
  ['with an argument it does not document', 'create_document', { body: BODY, force: true }],
]) {
  test(`a write ${why} is refused before any request`, async () => {
    const r = await tool(await claude(), name, args);
    assert.equal(r.result.isError, true);
    assert.ok(r.result.content[0].text.startsWith(`${name}: `), r.result.content[0].text);
  });
}

test('a write that ZapSign answers with nothing is reported by its status', async () => {
  const server = await claude({ readKey: () => 'k', fetch: async () => new Response(null, { status: 204 }) });
  const r = await tool(server, 'delete_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, undefined);
  assert.match(r.result.content[0].text, /204/);
});

test('a write is kept in the log with what was sent', async () => {
  const root = temp('zs-');
  const server = await claude({ logRoot: root, readKey: () => 'k', fetch: reply(200, { token: 's-9' }) });
  await tool(server, 'add_signer', { doc_token: DOC_TOKEN, body: BODY });
  const entry = JSON.parse(logged(root).trim());
  assert.equal(entry.tool, 'add_signer');
  assert.deepEqual(entry.arguments, { doc_token: DOC_TOKEN, body: BODY });
  assert.deepEqual(entry.response, { token: 's-9' });
});

test('validating a signed PDF sends that file, and nothing else, as the form field "file"', async () => {
  const folder = temp('zs-pdf-');
  const file = path.join(folder, 'signed.pdf');
  fs.writeFileSync(file, '%PDF-1.7 stand-in');
  const seen = [];
  const server = await claude({
    readKey: () => 'k',
    fetch: async (url, init) => { seen.push(`${init.method} ${url}`, init.headers['Content-Type'], init.body); return reply(200, { isValid: true })(); },
  });
  const r = await tool(server, 'validate_pdf_signature', { file_path: file });
  assert.equal(r.result.isError, undefined);
  assert.equal(seen[0], 'POST https://sandbox.api.zapsign.com.br/api/v1/validate-pdf-signature/');
  assert.equal(seen[1], undefined);
  assert.ok(seen[2] instanceof FormData);
  assert.deepEqual([...seen[2].keys()], ['file']);
  assert.equal(seen[2].get('file').name, 'signed.pdf');
  assert.equal(await seen[2].get('file').text(), '%PDF-1.7 stand-in');
});

for (const [why, make] of [
  ['that is not absolute', () => 'signed.pdf'],
  ['that does not exist', () => path.join(temp('zs-pdf-'), 'missing.pdf')],
  ['that is not a PDF', () => { const file = path.join(temp('zs-pdf-'), 'notes.txt'); fs.writeFileSync(file, 'x'); return file; }],
  ['that is a folder', () => { const folder = path.join(temp('zs-pdf-'), 'folder.pdf'); fs.mkdirSync(folder); return folder; }],
]) {
  test(`validating a file ${why} is refused before any request`, async () => {
    const r = await tool(await claude({ readKey: () => 'k' }), 'validate_pdf_signature', { file_path: make() });
    assert.equal(r.result.isError, true);
    assert.ok(r.result.content[0].text.startsWith('validate_pdf_signature: '), r.result.content[0].text);
  });
}

test('a write that got no answer says it may have arrived, and is kept in the log as unanswered', async () => {
  const root = temp('zs-');
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const server = await claude({ logRoot: root, readKey: () => 'k', fetch: async () => { throw timeout; } });
  const r = await tool(server, 'create_document', { body: BODY });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /may have reached ZapSign/);
  assert.match(r.result.content[0].text, /before sending it again/);
  const entry = JSON.parse(logged(root).trim());
  assert.equal(entry.tool, 'create_document');
  assert.equal(entry.status, null);
  assert.deepEqual(entry.arguments, { body: BODY });
  assert.match(entry.response, /timeout/);
});

test('a read that got no answer is simply an error: nothing is kept and nothing may have changed', async () => {
  const root = temp('zs-');
  const server = quiet({ logRoot: root, readKey: () => 'k', fetch: async () => { throw new TypeError('fetch failed'); } });
  const r = await tool(server, 'get_document', { doc_token: DOC_TOKEN });
  assert.equal(r.result.isError, true);
  assert.doesNotMatch(r.result.content[0].text, /may have reached/);
  assert.deepEqual(fs.readdirSync(root), []);
});
