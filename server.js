'use strict';
/**
 * Atlas QR / Barcode / Developer-utility API
 *
 * On-demand code generation + data utilities, each gated behind a REAL x402
 * pay-per-request paywall (USDC on Base): payments are verified against an
 * x402 facilitator before work is served, and settled on-chain after.
 *
 * Public (free): GET /health, GET /stats, GET /, GET /.well-known/x402
 * Payable (x402): see ROUTES below. Every payable route advertises an x402
 * Bazaar discovery extension (input example + JSON schema + output example)
 * so agents and directory crawlers can discover and call it without a human.
 */
const http = require('http');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const yaml = require('js-yaml');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { decodePaymentHeader, verifyPayment, settlePayment, FACILITATOR_URL } = require('./payment');

const PORT = parseInt(process.env.PORT || '8080', 10);
// Pay-to wallet may be overridden by env for portability across deploys.
const PAY_TO = process.env.PAY_TO || '0xAdfAeBdfaf0F9fDc844FbB7421f940b8691E597E';
const NETWORK = 'base';
const USDC_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const VERSION = '1.3.1';
const MAX_BODY_BYTES = 128 * 1024;
const BATCH_MAX = 25;

// Price helpers (USDC has 6 decimals).
const usd = (n) => String(Math.round(n * 1e6));
const PRICE = {
  code: usd(0.002),      // raw QR / barcode image
  structured: usd(0.003), // format-aware QR (wifi/vcard/sepa/event)
  validate: usd(0.001),   // pure-compute validation, no image
  batch: usd(0.01),       // up to BATCH_MAX codes in one call
  convert: usd(0.002),    // data-format conversion (csv/yaml/json)
  pdf: usd(0.01),         // PDF document / table generation
};

// Simple in-memory revenue metering (also appended to revenue.log for durability).
const REVENUE_LOG = path.join(__dirname, 'revenue.log');
const stats = { started: new Date().toISOString(), version: VERSION, requests: 0, paid: 0, settled: 0, settleFailed: 0, verifyFailed: 0, revenueAtomic: 0, byResource: {} };

function logRevenue(entry) {
  try { fs.appendFileSync(REVENUE_LOG, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n'); } catch (_) {}
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
function sendImage(res, status, buf, ct, extra = {}) {
  res.writeHead(status, { 'Content-Type': ct, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('Request body too large'), { statusCode: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

// ─── x402 payment requirements + Bazaar discovery extension ─────────────────
function requirementsFor(resource, description, priceAtomic) {
  return {
    scheme: 'exact', network: NETWORK, maxAmountRequired: priceAtomic, resource, description,
    mimeType: 'application/json', payTo: PAY_TO, asset: USDC_ASSET, maxTimeoutSeconds: 120,
    extra: { name: 'USD Coin', version: '2', decimals: 6, symbol: 'USDC' },
  };
}
function paymentRequiredBody(route) {
  // Carries the x402 Bazaar discovery extension so crawlers/agents can learn
  // the shape of the call (method, example input, JSON schema, example output).
  return {
    x402Version: 1,
    error: 'payment_required',
    accepts: [requirementsFor(route.resource, route.description, route.price)],
    extensions: {
      bazaar: {
        info: {
          input: { type: 'http', method: route.method, bodyType: 'json', example: route.inputExample },
          output: { type: route.outputType || 'image', example: route.outputExample },
        },
        schema: route.inputSchema,
      },
    },
  };
}

/**
 * Enforce a REAL x402 payment for a route. Returns a decoded+verified payload
 * to settle later, or null if the request was already answered.
 * FAIL-CLOSED: anything other than a verified payment results in no service.
 */
async function enforcePayment(req, res, route) {
  const payload = decodePaymentHeader(req);
  const requirements = requirementsFor(route.resource, route.description, route.price);
  if (!payload) {
    sendJson(res, 402, paymentRequiredBody(route), { 'X-Payment-Required': route.price, Accept: 'application/x402+json' });
    return null;
  }
  const v = await verifyPayment(payload, requirements);
  if (!v.ok) {
    stats.verifyFailed++;
    logRevenue({ event: 'verify_failed', resource: route.resource, reason: v.reason });
    sendJson(res, 402, { ...paymentRequiredBody(route), verifyError: v.reason }, { 'X-Payment-Required': route.price, Accept: 'application/x402+json' });
    return null;
  }
  stats.paid++;
  return { payload, requirements };
}

/** Settle after the work is delivered; returns the X-Payment-Response header value (or ''). */
async function settleAfter(gate, route) {
  const s = await settlePayment(gate.payload, gate.requirements);
  if (s.ok) {
    stats.settled++;
    stats.revenueAtomic += Number(route.price);
    stats.byResource[route.resource] = (stats.byResource[route.resource] || 0) + 1;
    logRevenue({ event: 'settled', resource: route.resource, txHash: s.txHash, payer: s.payer, amountAtomic: route.price });
    return Buffer.from(JSON.stringify({ success: true, transaction: s.txHash, network: NETWORK })).toString('base64');
  }
  stats.settleFailed++;
  logRevenue({ event: 'settle_failed', resource: route.resource, reason: s.reason });
  return '';
}
// ─── Generators ─────────────────────────────────────────────────────────────
async function renderQr(data, { size = 256, format = 'png', ecc = 'M' } = {}) {
  if (format === 'svg') {
    return { buf: Buffer.from(await QRCode.toString(data, { type: 'svg', errorCorrectionLevel: ecc, width: size, margin: 1 }), 'utf8'), ct: 'image/svg+xml' };
  }
  return { buf: await QRCode.toBuffer(data, { type: 'png', errorCorrectionLevel: ecc, width: size, margin: 1 }), ct: 'image/png' };
}
async function renderQrDataUrl(data, opts) {
  const { buf, ct } = await renderQr(data, opts);
  return `data:${ct};base64,${buf.toString('base64')}`;
}

// Escape per the respective text/QR grammars.
const escWifi = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');
const escVcard = (s) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
const escIcs = (s) => String(s).replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');

function buildWifi({ ssid, password = '', encryption = 'WPA', hidden = false }) {
  const enc = String(encryption).toUpperCase() === 'NOPASS' ? 'nopass' : String(encryption).toUpperCase();
  return `WIFI:T:${enc};S:${escWifi(ssid)};${enc === 'nopass' ? '' : 'P:' + escWifi(password) + ';'}${hidden ? 'H:true;' : ''};`;
}
function buildVCard({ name, org, title, phone, email, url, address }) {
  const L = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escVcard(name)}`];
  if (org) L.push(`ORG:${escVcard(org)}`);
  if (title) L.push(`TITLE:${escVcard(title)}`);
  if (phone) L.push(`TEL;TYPE=CELL:${escVcard(phone)}`);
  if (email) L.push(`EMAIL:${escVcard(email)}`);
  if (url) L.push(`URL:${escVcard(url)}`);
  if (address) L.push(`ADR:;;${escVcard(address)};;;;`);
  L.push('END:VCARD');
  return L.join('\n');
}
// EPC/SEPA "GiroCode" QR (EPC069-12). Amount EUR, 2 decimals.
function buildSepa({ name, iban, amount, remittance = '' }) {
  const amt = amount !== undefined ? `EUR${Number(amount).toFixed(2)}` : '';
  return ['BCD', '002', '1', 'SCT', '', String(name), String(iban).replace(/\s+/g, ''), amt, '', '', String(remittance)].join('\n');
}
function buildIcs({ title, start, end, location = '', description = '' }) {
  const dt = (v) => new Date(v).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Atlas//qr-api//EN', 'BEGIN:VEVENT', `UID:${Date.now()}@atlas-qr`, `DTSTAMP:${dt(Date.now())}`, `DTSTART:${dt(start)}`];
  if (end) L.push(`DTEND:${dt(end)}`);
  L.push(`SUMMARY:${escIcs(title)}`);
  if (location) L.push(`LOCATION:${escIcs(location)}`);
  if (description) L.push(`DESCRIPTION:${escIcs(description)}`);
  L.push('END:VEVENT', 'END:VCALENDAR');
  return L.join('\n');
}

// GTIN/EAN/UPC check-digit (mod-10). Returns {valid, expected, normalized}.
function gtinCheck(raw, type) {
  const digits = String(raw).replace(/\D/g, '');
  const lens = { upc: 12, ean13: 13, gtin: digits.length };
  const len = lens[type] || digits.length;
  if (![8, 12, 13, 14].includes(len) || digits.length !== len) {
    return { ok: false, error: `expected ${len} digits for ${type}, got ${digits.length}` };
  }
  const body = digits.slice(0, -1);
  const given = Number(digits.slice(-1));
  let sum = 0;
  const rev = body.split('').reverse();
  for (let i = 0; i < rev.length; i++) sum += Number(rev[i]) * (i % 2 === 0 ? 3 : 1);
  const expected = (10 - (sum % 10)) % 10;
  return { ok: true, valid: given === expected, given, expected, corrected: body + expected };
}
// ─── Data converters ─────────────────────────────────────────────────────────
// RFC4180-ish CSV parser: handles quoted fields, embedded commas/newlines, "" escapes.
function parseCsv(text, { header = true, delimiter = ',' } = {}) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!header) return rows;
  if (rows.length === 0) return [];
  const keys = rows[0];
  return rows.slice(1).map((r) => { const o = {}; keys.forEach((k, idx) => { o[k] = r[idx] !== undefined ? r[idx] : ''; }); return o; });
}
function toCsv(arr, { headers, delimiter = ',' } = {}) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const cols = headers || Array.from(arr.reduce((set, o) => { Object.keys(o || {}).forEach((k) => set.add(k)); return set; }, new Set()));
  const esc = (v) => {
    const str = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  };
  const lines = [cols.map(esc).join(delimiter)];
  for (const o of arr) lines.push(cols.map((c) => esc(o ? o[c] : '')).join(delimiter));
  return lines.join('\n');
}

// ─── PDF generators (pdf-lib, standard fonts only — no external assets) ───────
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
function wrapText(text, font, fontSize, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const trial = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(trial, fontSize) > maxWidth && line) { out.push(line); line = word; }
      else line = trial;
    }
    if (line) out.push(line);
  }
  return out;
}
async function pdfDocument({ title, paragraphs, pageSize = 'a4' }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [w, h] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
  const margin = 56, fs = 11, lh = 16, maxW = w - margin * 2;
  let page = doc.addPage([w, h]); let y = h - margin;
  const nl = (n = lh) => { y -= n; if (y < margin) { page = doc.addPage([w, h]); y = h - margin; } };
  if (title) { page.drawText(String(title).slice(0, 200), { x: margin, y, size: 18, font: bold, color: rgb(0, 0, 0) }); nl(28); }
  for (const para of (paragraphs || [])) {
    for (const line of wrapText(para, font, fs, maxW)) { page.drawText(line, { x: margin, y, size: fs, font }); nl(); }
    nl(6);
  }
  return Buffer.from(await doc.save());
}
async function pdfTable({ title, headers, rows, pageSize = 'a4' }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [w, h] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
  const margin = 40, fs = 10, rh = 20, maxW = w - margin * 2;
  const colW = maxW / headers.length;
  let page = doc.addPage([w, h]); let y = h - margin;
  const clip = (t) => { let str = t === null || t === undefined ? '' : String(t); while (str && font.widthOfTextAtSize(str, fs) > colW - 8) str = str.slice(0, -1); return str; };
  const drawRow = (cells, f) => {
    if (y < margin + rh) { page = doc.addPage([w, h]); y = h - margin; }
    cells.forEach((c, i) => page.drawText(clip(c), { x: margin + i * colW + 2, y: y - 14, size: fs, font: f }));
    page.drawLine({ start: { x: margin, y: y - rh }, end: { x: w - margin, y: y - rh }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    y -= rh;
  };
  if (title) { page.drawText(String(title).slice(0, 200), { x: margin, y: y - 14, size: 16, font: bold }); y -= 34; }
  drawRow(headers, bold);
  for (const r of rows) drawRow(r, font);
  return Buffer.from(await doc.save());
}

// ─── Shared validators ───────────────────────────────────────────────────────
function qrOpts(body) {
  let size = body.size === undefined ? 256 : body.size;
  if (!Number.isInteger(size) || size < 32 || size > 1024) return { error: '`size` must be an integer 32–1024' };
  const format = body.format === undefined ? 'png' : body.format;
  if (format !== 'png' && format !== 'svg') return { error: "`format` must be 'png' or 'svg'" };
  const ecc = body.ecc === undefined ? 'M' : body.ecc;
  if (!['L', 'M', 'Q', 'H'].includes(ecc)) return { error: "`ecc` must be one of 'L','M','Q','H'" };
  return { size, format, ecc };
}
const reqStr = (v, name, max) => (typeof v !== 'string' || v.length === 0) ? `\`${name}\` is required (non-empty string)` : (max && v.length > max ? `\`${name}\` exceeds ${max} chars` : null);

// ─── Route table (single source of truth for routing, pricing, 402 + discovery) ─
const ROUTES = [
  {
    method: 'POST', path: '/qr', price: PRICE.code, outputType: 'image',
    description: 'Generate a QR code (PNG or SVG) from arbitrary data.',
    inputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'string', maxLength: 2000 }, size: { type: 'integer', minimum: 32, maximum: 1024 }, format: { enum: ['png', 'svg'] }, ecc: { enum: ['L', 'M', 'Q', 'H'] } } },
    inputExample: { data: 'https://example.com', size: 256, format: 'png', ecc: 'M' },
    outputExample: 'image/png (binary)',
    validate(b) { const e = reqStr(b.data, 'data', 2000); if (e) return { error: e }; const o = qrOpts(b); if (o.error) return o; return { data: b.data, ...o }; },
    async produce(p) { return { image: await renderQr(p.data, p) }; },
  },
  {
    method: 'POST', path: '/barcode', price: PRICE.code, outputType: 'image',
    description: 'Generate a 1D barcode PNG (code128, ean13, or upc).',
    inputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'string', maxLength: 512 }, type: { enum: ['code128', 'ean13', 'upc'] } } },
    inputExample: { data: 'HELLO-123', type: 'code128' },
    outputExample: 'image/png (binary)',
    validate(b) { const e = reqStr(b.data, 'data', 512); if (e) return { error: e }; const map = { code128: 'code128', ean13: 'ean13', upc: 'upca' }; const type = b.type || 'code128'; if (!map[type]) return { error: "`type` must be 'code128','ean13','upc'" }; return { data: b.data, bcid: map[type] }; },
    async produce(p) { const buf = await bwipjs.toBuffer({ bcid: p.bcid, text: p.data, scale: 3, height: 12, includetext: true, textxalign: 'center' }); return { image: { buf, ct: 'image/png' } }; },
  },
  {
    method: 'POST', path: '/qr/wifi', price: PRICE.structured, outputType: 'image',
    description: 'Generate a WiFi join QR (scanning it connects the device to the network).',
    inputSchema: { type: 'object', required: ['ssid'], properties: { ssid: { type: 'string' }, password: { type: 'string' }, encryption: { enum: ['WPA', 'WEP', 'nopass'] }, hidden: { type: 'boolean' }, size: { type: 'integer' } } },
    inputExample: { ssid: 'MyNetwork', password: 'hunter2', encryption: 'WPA' },
    outputExample: 'image/png (binary)',
    validate(b) { const e = reqStr(b.ssid, 'ssid', 256); if (e) return { error: e }; const o = qrOpts(b); if (o.error) return o; return { payload: buildWifi(b), ...o }; },
    async produce(p) { return { image: await renderQr(p.payload, p) }; },
  },
  {
    method: 'POST', path: '/qr/vcard', price: PRICE.structured, outputType: 'image',
    description: 'Generate a vCard contact QR (scanning it adds the contact).',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, org: { type: 'string' }, title: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' }, url: { type: 'string' }, address: { type: 'string' } } },
    inputExample: { name: 'Ada Lovelace', org: 'Analytical Engines', email: 'ada@example.com', phone: '+1-555-0100' },
    outputExample: 'image/png (binary)',
    validate(b) { const e = reqStr(b.name, 'name', 256); if (e) return { error: e }; const o = qrOpts(b); if (o.error) return o; return { payload: buildVCard(b), ...o }; },
    async produce(p) { return { image: await renderQr(p.payload, p) }; },
  },
  {
    method: 'POST', path: '/qr/sepa', price: PRICE.structured, outputType: 'image',
    description: 'Generate an EPC/SEPA GiroCode QR for a EUR bank transfer (name, IBAN, amount).',
    inputSchema: { type: 'object', required: ['name', 'iban'], properties: { name: { type: 'string' }, iban: { type: 'string' }, amount: { type: 'number' }, remittance: { type: 'string' } } },
    inputExample: { name: 'Open Source Fund', iban: 'DE89370400440532013000', amount: 25.0, remittance: 'Donation' },
    outputExample: 'image/png (binary)',
    validate(b) { let e = reqStr(b.name, 'name', 70) || reqStr(b.iban, 'iban', 34); if (e) return { error: e }; if (b.amount !== undefined && (typeof b.amount !== 'number' || b.amount < 0 || b.amount > 999999999.99)) return { error: '`amount` must be a non-negative number' }; const o = qrOpts(b); if (o.error) return o; return { payload: buildSepa(b), ...o }; },
    async produce(p) { return { image: await renderQr(p.payload, { ...p, ecc: 'M' }) }; },
  },
  {
    method: 'POST', path: '/qr/event', price: PRICE.structured, outputType: 'image',
    description: 'Generate a calendar-event QR (iCalendar VEVENT) from title/start/end/location.',
    inputSchema: { type: 'object', required: ['title', 'start'], properties: { title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601' }, end: { type: 'string' }, location: { type: 'string' }, description: { type: 'string' } } },
    inputExample: { title: 'Launch call', start: '2026-11-01T15:00:00Z', end: '2026-11-01T15:30:00Z', location: 'Zoom' },
    outputExample: 'image/png (binary)',
    validate(b) { let e = reqStr(b.title, 'title', 256) || reqStr(b.start, 'start', 64); if (e) return { error: e }; if (isNaN(new Date(b.start).getTime())) return { error: '`start` must be a valid date/ISO-8601 string' }; if (b.end && isNaN(new Date(b.end).getTime())) return { error: '`end` must be a valid date/ISO-8601 string' }; const o = qrOpts(b); if (o.error) return o; return { payload: buildIcs(b), ...o }; },
    async produce(p) { return { image: await renderQr(p.payload, p) }; },
  },
  {
    method: 'POST', path: '/barcode/validate', price: PRICE.validate, outputType: 'json',
    description: 'Validate a UPC/EAN/GTIN check digit and return the corrected value. No image.',
    inputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'string' }, type: { enum: ['upc', 'ean13', 'gtin'] } } },
    inputExample: { data: '036000291452', type: 'upc' },
    outputType: 'json', outputExample: { valid: true, given: 2, expected: 2, corrected: '036000291452' },
    validate(b) { const e = reqStr(b.data, 'data', 64); if (e) return { error: e }; const type = b.type || 'gtin'; if (!['upc', 'ean13', 'gtin'].includes(type)) return { error: "`type` must be 'upc','ean13','gtin'" }; return { data: b.data, type }; },
    async produce(p) { const r = gtinCheck(p.data, p.type); if (!r.ok) return { json: { error: r.error }, status: 400 }; return { json: { type: p.type, valid: r.valid, given: r.given, expected: r.expected, corrected: r.corrected } }; },
  },
  {
    method: 'POST', path: '/qr/batch', price: PRICE.batch, outputType: 'json',
    description: `Generate up to ${BATCH_MAX} QR codes in one call; returns an array of PNG data URLs.`,
    inputSchema: { type: 'object', required: ['items'], properties: { items: { type: 'array', maxItems: BATCH_MAX, items: { type: 'object', required: ['data'], properties: { data: { type: 'string' }, size: { type: 'integer' }, ecc: { enum: ['L', 'M', 'Q', 'H'] } } } } } },
    inputExample: { items: [{ data: 'https://a.example' }, { data: 'https://b.example', size: 128 }] },
    outputType: 'json', outputExample: { count: 2, images: ['data:image/png;base64,...', 'data:image/png;base64,...'] },
    validate(b) { if (!Array.isArray(b.items) || b.items.length === 0) return { error: '`items` must be a non-empty array' }; if (b.items.length > BATCH_MAX) return { error: `\`items\` exceeds max of ${BATCH_MAX}` }; for (const it of b.items) { const e = reqStr(it && it.data, 'items[].data', 2000); if (e) return { error: e }; } return { items: b.items }; },
    async produce(p) { const images = []; for (const it of p.items) { images.push(await renderQrDataUrl(it.data, { size: it.size, ecc: it.ecc })); } return { json: { count: images.length, images } }; },
  },
  {
    method: 'POST', path: '/convert/csv2json', price: PRICE.convert, outputType: 'json',
    description: 'Parse CSV (RFC4180: quotes, embedded commas/newlines) into a JSON array of objects.',
    inputSchema: { type: 'object', required: ['csv'], properties: { csv: { type: 'string' }, header: { type: 'boolean', default: true }, delimiter: { type: 'string', default: ',' } } },
    inputExample: { csv: 'name,age\nAda,36\n"Grace, H.",45', header: true },
    outputType: 'json', outputExample: { count: 2, rows: [{ name: 'Ada', age: '36' }] },
    validate(b) { const e = reqStr(b.csv, 'csv'); if (e) return { error: e }; const delimiter = b.delimiter || ','; if (typeof delimiter !== 'string' || delimiter.length !== 1) return { error: '`delimiter` must be a single character' }; return { csv: b.csv, header: b.header !== false, delimiter }; },
    async produce(p) { const rows = parseCsv(p.csv, { header: p.header, delimiter: p.delimiter }); return { json: { count: Array.isArray(rows) ? rows.length : 0, rows } }; },
  },
  {
    method: 'POST', path: '/convert/json2csv', price: PRICE.convert, outputType: 'csv',
    description: 'Serialize a JSON array of objects into CSV text (RFC4180 quoting).',
    inputSchema: { type: 'object', required: ['json'], properties: { json: { type: 'array', items: { type: 'object' } }, headers: { type: 'array', items: { type: 'string' } }, delimiter: { type: 'string', default: ',' } } },
    inputExample: { json: [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 45 }] },
    outputType: 'csv', outputExample: 'name,age\nAda,36\nGrace,45',
    validate(b) { if (!Array.isArray(b.json)) return { error: '`json` must be an array of objects' }; if (b.headers !== undefined && !Array.isArray(b.headers)) return { error: '`headers` must be an array of strings' }; const delimiter = b.delimiter || ','; if (typeof delimiter !== 'string' || delimiter.length !== 1) return { error: '`delimiter` must be a single character' }; return { json: b.json, headers: b.headers, delimiter }; },
    async produce(p) { return { image: { buf: Buffer.from(toCsv(p.json, { headers: p.headers, delimiter: p.delimiter }), 'utf8'), ct: 'text/csv; charset=utf-8' } }; },
  },
  {
    method: 'POST', path: '/convert/yaml2json', price: PRICE.convert, outputType: 'json',
    description: 'Parse a YAML document into JSON.',
    inputSchema: { type: 'object', required: ['yaml'], properties: { yaml: { type: 'string' } } },
    inputExample: { yaml: 'name: Ada\nskills:\n  - math\n  - code' },
    outputType: 'json', outputExample: { name: 'Ada', skills: ['math', 'code'] },
    validate(b) { const e = reqStr(b.yaml, 'yaml'); if (e) return { error: e }; return { yaml: b.yaml }; },
    async produce(p) { let data; try { data = yaml.load(p.yaml, { schema: yaml.JSON_SCHEMA }); } catch (e) { return { json: { error: 'invalid YAML: ' + String(e.message || e) }, status: 400 }; } return { json: { data } }; },
  },
  {
    method: 'POST', path: '/convert/json2yaml', price: PRICE.convert, outputType: 'yaml',
    description: 'Serialize a JSON value into a YAML document.',
    inputSchema: { type: 'object', required: ['json'], properties: { json: {} } },
    inputExample: { json: { name: 'Ada', skills: ['math', 'code'] } },
    outputType: 'yaml', outputExample: 'name: Ada\nskills:\n  - math\n  - code\n',
    validate(b) { if (!('json' in b)) return { error: '`json` is required' }; return { json: b.json }; },
    async produce(p) { return { image: { buf: Buffer.from(yaml.dump(p.json, { lineWidth: 120 }), 'utf8'), ct: 'application/yaml; charset=utf-8' } }; },
  },
  {
    method: 'POST', path: '/pdf/document', price: PRICE.pdf, outputType: 'pdf',
    description: 'Generate a text PDF (title + wrapped paragraphs). Pass `paragraphs` (array) or `text` (string).',
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } }, pageSize: { enum: ['a4', 'letter'] } } },
    inputExample: { title: 'Report', paragraphs: ['First paragraph.', 'Second paragraph.'], pageSize: 'a4' },
    outputType: 'pdf', outputExample: 'application/pdf (binary)',
    validate(b) { let paragraphs = b.paragraphs; if (paragraphs === undefined && typeof b.text === 'string') paragraphs = [b.text]; if (!Array.isArray(paragraphs) || paragraphs.length === 0) return { error: 'provide `paragraphs` (array of strings) or `text` (string)' }; if (!paragraphs.every((x) => typeof x === 'string')) return { error: '`paragraphs` must be strings' }; if (paragraphs.length > 500) return { error: '`paragraphs` exceeds 500' }; const pageSize = b.pageSize || 'a4'; if (!['a4', 'letter'].includes(pageSize)) return { error: "`pageSize` must be 'a4' or 'letter'" }; return { title: b.title, paragraphs, pageSize }; },
    async produce(p) { return { image: { buf: await pdfDocument(p), ct: 'application/pdf' } }; },
  },
  {
    method: 'POST', path: '/pdf/table', price: PRICE.pdf, outputType: 'pdf',
    description: 'Generate a tabular PDF (headers + rows) — invoices, reports, labels.',
    inputSchema: { type: 'object', required: ['headers', 'rows'], properties: { title: { type: 'string' }, headers: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array' } }, pageSize: { enum: ['a4', 'letter'] } } },
    inputExample: { title: 'Invoice', headers: ['Item', 'Qty', 'Price'], rows: [['Widget', '2', '$10'], ['Gadget', '1', '$25']] },
    outputType: 'pdf', outputExample: 'application/pdf (binary)',
    validate(b) { if (!Array.isArray(b.headers) || b.headers.length === 0 || b.headers.length > 20) return { error: '`headers` must be a non-empty array (max 20)' }; if (!b.headers.every((x) => typeof x === 'string')) return { error: '`headers` must be strings' }; if (!Array.isArray(b.rows)) return { error: '`rows` must be an array of arrays' }; if (b.rows.length > 1000) return { error: '`rows` exceeds 1000' }; if (!b.rows.every((r) => Array.isArray(r))) return { error: 'each row must be an array' }; const pageSize = b.pageSize || 'a4'; if (!['a4', 'letter'].includes(pageSize)) return { error: "`pageSize` must be 'a4' or 'letter'" }; return { title: b.title, headers: b.headers, rows: b.rows, pageSize }; },
    async produce(p) { return { image: { buf: await pdfTable(p), ct: 'application/pdf' } }; },
  },
];
const ROUTE_MAP = new Map(ROUTES.map((r) => [`${r.method} ${r.path}`, { ...r, resource: r.path }]));
// ─── Generic payable-route runner ────────────────────────────────────────────
async function runPayable(req, res, route) {
  const gate = await enforcePayment(req, res, route);
  if (!gate) return; // 402 already sent
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, e.statusCode || 400, { error: e.message }); }
  const p = route.validate(body);
  if (p && p.error) return sendJson(res, 400, { error: p.error });
  let result;
  try { result = await route.produce(p); } catch (e) { return sendJson(res, 500, { error: 'generation failed', detail: String(e.message || e) }); }
  if (result.json && result.status === 400) return sendJson(res, 400, result.json);
  const xpr = await settleAfter(gate, route);
  const extra = xpr ? { 'X-Payment-Response': xpr } : {};
  if (result.image) return sendImage(res, 200, result.image.buf, result.image.ct, extra);
  return sendJson(res, 200, result.json, extra);
}

// ─── Public (free) handlers ───────────────────────────────────────────────────
function handleHealth(req, res) { sendJson(res, 200, { status: 'ok', version: VERSION, time: new Date().toISOString() }); }
function handleStats(req, res) {
  sendJson(res, 200, { ...stats, revenueUsd: (stats.revenueAtomic / 1e6).toFixed(6), payTo: PAY_TO, network: NETWORK, facilitator: FACILITATOR_URL });
}
// Machine-readable catalog for x402 directories / agent crawlers.
function catalog(baseUrl) {
  return {
    name: 'Atlas QR / Barcode / Dev-utility API',
    description: 'Pay-per-call code generation and data utilities over x402 (USDC on Base). No signup, no API key.',
    x402Version: 1, network: NETWORK, asset: USDC_ASSET, payTo: PAY_TO, facilitator: FACILITATOR_URL,
    baseUrl,
    openapi: baseUrl + '/openapi.json',
    endpoints: ROUTES.map((r) => ({
      method: r.method, path: r.path, priceAtomicUsdc: r.price, priceUsd: (Number(r.price) / 1e6).toFixed(6),
      description: r.description, inputSchema: r.inputSchema, inputExample: r.inputExample,
      outputType: r.outputType || 'image', outputExample: r.outputExample,
    })),
  };
}
function baseUrlOf(req) {
  // Prefer an explicitly configured public URL, then the Cloudflare tunnel URL
  // recorded in public_url.txt, then fall back to request headers. This keeps
  // the advertised catalog URL correct behind the quick tunnel (whose hostname
  // rotates on restart; keepalive.sh refreshes public_url.txt).
  const env = (process.env.PUBLIC_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  try {
    const fromFile = fs.readFileSync(path.join(__dirname, 'public_url.txt'), 'utf8').trim();
    if (fromFile) return fromFile.replace(/\/+$/, '');
  } catch (_) { /* fall through */ }
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}
function handleCatalog(req, res) { sendJson(res, 200, catalog(baseUrlOf(req)), { 'Cache-Control': 'public, max-age=300' }); }

// OpenAPI 3.1 spec auto-generated from the route table, so tool-using agents
// can auto-integrate. Each payable path documents its JSON body + the 402
// payment-required response (x402, USDC on Base).
function buildOpenApi(baseUrl) {
  const paths = {};
  for (const r of ROUTES) {
    const priceUsd = (Number(r.price) / 1e6).toFixed(6);
    const okContent = (r.outputType === 'json')
      ? { 'application/json': { example: r.outputExample } }
      : { '*/*': { schema: { type: 'string', format: 'binary' }, example: r.outputExample } };
    paths[r.path] = {
      post: {
        summary: r.description,
        description: `${r.description}\n\nPayment: x402, $${priceUsd} USDC on Base to ${PAY_TO}. Send an x402 \`X-PAYMENT\` header; unpaid requests return HTTP 402 with payment requirements.`,
        requestBody: { required: true, content: { 'application/json': { schema: r.inputSchema, example: r.inputExample } } },
        responses: {
          '200': { description: 'Generated result', content: okContent },
          '402': { description: 'Payment required (x402). Body carries payment requirements + Bazaar discovery extension.' },
          '400': { description: 'Invalid request body' },
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Atlas QR / Barcode / Dev-utility API',
      version: VERSION,
      description: 'Pay-per-call code generation and data utilities over x402 (USDC on Base). No signup, no API key. Catalog: /.well-known/x402',
    },
    servers: [{ url: baseUrl }],
    paths,
  };
}
function handleOpenApi(req, res) { sendJson(res, 200, buildOpenApi(baseUrlOf(req)), { 'Cache-Control': 'public, max-age=300' }); }


function handleLanding(req, res) {
  const rows = ROUTES.map((r) => `<tr><td>${r.method}</td><td><code>${r.path}</code></td><td>$${(Number(r.price) / 1e6).toFixed(3)}</td><td>${r.description}</td></tr>`).join('');
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Atlas x402 API</title>'
    + '<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;line-height:1.55;color:#1a1a1a}code,pre{background:#f4f4f5;border-radius:6px}code{padding:2px 6px}pre{padding:14px;overflow:auto}h1{margin-bottom:0}.muted{color:#666}table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #ddd;padding:8px;text-align:left;vertical-align:top}</style></head><body>'
    + '<h1>Atlas QR / Barcode / Dev-utility API</h1>'
    + '<p class="muted">Pay-per-request code generation &amp; data utilities via x402 (USDC on Base). No signup, no API key. x402-aware clients get an HTTP 402 with payment requirements, pay, and retry automatically.</p>'
    + '<p>Machine-readable catalog: <code>GET /.well-known/x402</code>. Payments settle to <code>' + PAY_TO + '</code> on Base.</p>'
    + '<h2>Endpoints</h2><table><tr><th>Method</th><th>Path</th><th>Price</th><th>Description</th></tr>'
    + '<tr><td>GET</td><td><code>/health</code></td><td>free</td><td>Liveness check</td></tr>'
    + '<tr><td>GET</td><td><code>/stats</code></td><td>free</td><td>Usage &amp; revenue metering</td></tr>'
    + '<tr><td>GET</td><td><code>/.well-known/x402</code></td><td>free</td><td>Machine-readable catalog</td></tr>'
    + '<tr><td>GET</td><td><code>/openapi.json</code></td><td>free</td><td>OpenAPI 3.1 spec (agent auto-integration)</td></tr>'
    + rows + '</table>'
    + '<h2>Example</h2><pre>curl -X POST &lt;BASE_URL&gt;/qr/wifi -H "content-type: application/json" \\\n  -d \'{"ssid":"MyNetwork","password":"hunter2","encryption":"WPA"}\' --output wifi.png</pre>'
    + '<p class="muted">Unverified payments are rejected (fail-closed).</p>'
    + '</body></html>';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

// ─── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];
  stats.requests++;
  try {
    if (req.method === 'GET' && url === '/health') return handleHealth(req, res);
    if (req.method === 'GET' && url === '/stats') return handleStats(req, res);
    if (req.method === 'GET' && (url === '/.well-known/x402' || url === '/catalog')) return handleCatalog(req, res);
    if (req.method === 'GET' && (url === '/openapi.json' || url === '/.well-known/openapi.json')) return handleOpenApi(req, res);
    if (req.method === 'GET' && url === '/') return handleLanding(req, res);
    const route = ROUTE_MAP.get(`${req.method} ${url}`);
    if (route) return await runPayable(req, res, route);
    return sendJson(res, 404, { error: 'Not found', path: url });
  } catch (e) { return sendJson(res, 500, { error: 'Internal error', detail: String(e.message || e) }); }
});
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Atlas x402 API v' + VERSION + ' listening on :' + PORT);
    console.log('Pay-to: ' + PAY_TO + ' | network: ' + NETWORK);
    console.log('Facilitator: ' + FACILITATOR_URL + ' | payments VERIFIED + SETTLED (fail-closed)');
    console.log('Payable routes: ' + ROUTES.map((r) => r.path).join(', '));
  });
}

module.exports = { server, ROUTES, catalog, buildWifi, buildVCard, buildSepa, buildIcs, gtinCheck, renderQr, parseCsv, toCsv, pdfDocument, pdfTable };



