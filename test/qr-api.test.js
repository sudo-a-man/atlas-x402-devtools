'use strict';
/**
 * qr-api test suite (node --test). No network, no real payments, no spend.
 * A local MOCK x402 facilitator stands in for the real one so we can exercise
 * the full paid happy-path (verify -> serve -> settle) that production has
 * never actually observed, plus generators, 402 shape, and fail-closed denial.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// Point the server at a mock facilitator BEFORE requiring it (payment.js reads
// the env at load) and keep it off the real :8080.
let mockFacilitator, serverBase, mockState = { verifyValid: true };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

before(async () => {
  mockFacilitator = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/verify') return res.end(JSON.stringify({ isValid: mockState.verifyValid, invalidReason: mockState.verifyValid ? undefined : 'mock_denied' }));
      if (req.url === '/settle') return res.end(JSON.stringify({ success: true, transaction: '0xtesttx', network: 'base', payer: '0xpayer' }));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => mockFacilitator.listen(0, r));
  process.env.X402_FACILITATOR_URL = `http://localhost:${mockFacilitator.address().port}`;

  const { server } = require('../server.js');
  await new Promise((r) => server.listen(0, r));
  serverBase = `http://localhost:${server.address().port}`;
  globalThis.__server = server;
});

after(() => {
  try { globalThis.__server && globalThis.__server.close(); } catch (_) {}
  try { mockFacilitator && mockFacilitator.close(); } catch (_) {}
});

const post = (path, body, headers = {}) => fetch(serverBase + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const PAY = { 'x-payment': b64({ x402Version: 1, scheme: 'exact', network: 'base', payload: {} }) };
// __APPEND_MARKER__

test('GET /health is public and reports version', async () => {
  const r = await fetch(serverBase + '/health');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.status, 'ok');
  assert.ok(j.version);
});

test('GET /.well-known/x402 lists all payable routes with prices + schemas', async () => {
  const r = await fetch(serverBase + '/.well-known/x402');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.endpoints.length, 14);
  for (const e of j.endpoints) {
    assert.ok(e.method && e.path && e.priceAtomicUsdc && e.inputSchema, `route ${e.path} well-formed`);
  }
});

test('unpaid payable route returns 402 with the x402 Bazaar discovery extension', async () => {
  const r = await post('/qr/wifi', { ssid: 'Net' });
  assert.strictEqual(r.status, 402);
  const j = await r.json();
  assert.strictEqual(j.error, 'payment_required');
  assert.strictEqual(j.accepts[0].maxAmountRequired, '3000');
  assert.strictEqual(j.extensions.bazaar.info.input.method, 'POST');
  assert.deepStrictEqual(j.extensions.bazaar.schema.required, ['ssid']);
});

test('fail-closed: an invalid payment (facilitator says not valid) is denied 402', async () => {
  mockState.verifyValid = false;
  const r = await post('/qr', { data: 'x' }, PAY);
  assert.strictEqual(r.status, 402);
  const j = await r.json();
  assert.ok(j.verifyError, 'carries verify failure reason');
  mockState.verifyValid = true;
});

test('PAID happy-path: /qr serves a PNG + X-Payment-Response after settle', async () => {
  const r = await post('/qr', { data: 'https://example.com', size: 128 }, PAY);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/png');
  assert.ok(r.headers.get('x-payment-response'), 'settlement header present');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 100 && buf.slice(1, 4).toString() === 'PNG', 'valid PNG bytes');
});

test('PAID happy-path: /convert/json2csv returns CSV text', async () => {
  const r = await post('/convert/json2csv', { json: [{ a: 1, b: 'x,y' }] }, PAY);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const text = await r.text();
  assert.strictEqual(text.split('\n')[0], 'a,b');
  assert.ok(text.includes('"x,y"'), 'RFC4180 quoting');
});

test('PAID happy-path: /pdf/table returns a PDF', async () => {
  const r = await post('/pdf/table', { title: 'Inv', headers: ['Item', 'Qty'], rows: [['Widget', '2']] }, PAY);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
});

test('paid-but-invalid body returns 400 (validation runs after payment)', async () => {
  const r = await post('/barcode/validate', { data: '123', type: 'nope' }, PAY);
  assert.strictEqual(r.status, 400);
});

test('unknown route returns 404', async () => {
  const r = await fetch(serverBase + '/nope');
  assert.strictEqual(r.status, 404);
});

