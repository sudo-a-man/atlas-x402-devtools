'use strict';
/**
 * Atlas x402 payment verification + settlement.
 *
 * Replaces the old insecure check (which accepted ANY non-empty x-payment
 * header and served images for free). This module decodes the x-payment
 * header into a PaymentPayload, verifies it against our payment requirements
 * via an x402 facilitator, and settles it on-chain after the work is served.
 *
 * FAIL-CLOSED: if verification cannot succeed, access is denied. We never
 * give away paid compute for free.
 *
 * The x402 package is ESM-only, so we lazy-load it via dynamic import() from
 * CommonJS and cache the facilitator handle.
 */

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || 'https://x402.org/facilitator';

let _facilitatorPromise = null;
function getFacilitator() {
  if (!_facilitatorPromise) {
    _facilitatorPromise = import('x402/verify')
      .then((mod) => {
        const useFacilitator = mod.useFacilitator || (mod.default && mod.default.useFacilitator);
        if (typeof useFacilitator !== 'function') {
          throw new Error('x402/verify did not export useFacilitator');
        }
        return useFacilitator({ url: FACILITATOR_URL });
      });
  }
  return _facilitatorPromise;
}

/**
 * Decode the x-payment header. x402 clients send a base64-encoded JSON
 * PaymentPayload. We tolerate raw JSON too.
 * @returns {object|null} decoded payload, or null if unparseable
 */
function decodePaymentHeader(req) {
  const h = req.headers['x-payment'] || req.headers['x-payment-payload'];
  if (typeof h !== 'string' || h.trim().length === 0) return null;
  const raw = h.trim();
  // Try base64 -> JSON first (the x402 standard), then raw JSON.
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) { /* fall through */ }
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Verify a payment against the given requirements.
 * @param {object} payload - decoded PaymentPayload
 * @param {object} requirements - a single PaymentRequirements object (the one from `accepts[0]`)
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
async function verifyPayment(payload, requirements) {
  if (!payload) return { ok: false, reason: 'missing_or_unparseable_payment_header' };
  let facilitator;
  try {
    facilitator = await getFacilitator();
  } catch (e) {
    return { ok: false, reason: 'facilitator_unavailable:' + (e && e.message ? e.message : String(e)) };
  }
  try {
    const result = await facilitator.verify(payload, requirements);
    // x402 verify returns { isValid: boolean, invalidReason?: string }
    if (result && result.isValid) return { ok: true };
    return { ok: false, reason: (result && (result.invalidReason || result.reason)) || 'verify_failed' };
  } catch (e) {
    return { ok: false, reason: 'verify_error:' + (e && e.message ? e.message : String(e)) };
  }
}

/**
 * Settle a verified payment on-chain. Best-effort; called AFTER the work is
 * delivered. Returns the settlement result for logging / response headers.
 * @returns {Promise<{ok:boolean, txHash?:string, reason?:string}>}
 */
async function settlePayment(payload, requirements) {
  let facilitator;
  try {
    facilitator = await getFacilitator();
  } catch (e) {
    return { ok: false, reason: 'facilitator_unavailable' };
  }
  try {
    const result = await facilitator.settle(payload, requirements);
    // x402 settle returns { success: boolean, transaction?: string, network?, payer? }
    if (result && (result.success || result.transaction)) {
      return { ok: true, txHash: result.transaction, payer: result.payer, network: result.network };
    }
    return { ok: false, reason: (result && (result.errorReason || result.error)) || 'settle_failed' };
  } catch (e) {
    return { ok: false, reason: 'settle_error:' + (e && e.message ? e.message : String(e)) };
  }
}

module.exports = { decodePaymentHeader, verifyPayment, settlePayment, FACILITATOR_URL };
