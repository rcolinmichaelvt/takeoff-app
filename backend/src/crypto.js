import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { AppError, requireCondition } from './errors.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
export const challengeFor = verifier => createHash('sha256').update(verifier).digest('base64url');

export function checkToken(value, name = 'token') {
  requireCondition(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value),
    400, 'INVALID_INPUT', `Invalid ${name}.`);
  return value;
}

export function normalizePublicKey(pem) {
  requireCondition(typeof pem === 'string' && pem.length < 2048 &&
    pem.startsWith('-----BEGIN PUBLIC KEY-----') && !pem.includes('PRIVATE'),
  400, 'INVALID_KEY', 'Provide a P-256 public key in SPKI PEM format.');
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Unexpected key type');
    }
    const der = key.export({ type: 'spki', format: 'der' });
    return { id: hash(der), pem: key.export({ type: 'spki', format: 'pem' }) };
  } catch {
    throw new AppError(400, 'INVALID_KEY', 'Provide a valid P-256 public key.');
  }
}

// UTF-8, LF separators, no trailing LF. The exact raw URL (including query order)
// and raw request bytes are signed. Native clients must not sign reserialized JSON.
export function signingMessage({ method, target, body, timestamp, nonce, token = '' }) {
  return ['takeoff-v1', method.toUpperCase(), target, hash(body || Buffer.alloc(0)),
    timestamp, nonce, token ? hash(token) : '-'].join('\n');
}

export function verifyProof({ publicKey, request, token = '', now, windowMs }) {
  const { timestamp, nonce, signature } = request.proof;
  requireCondition(typeof timestamp === 'string' && /^\d{10,11}$/.test(timestamp) &&
    Math.abs(now - Number(timestamp) * 1000) <= windowMs,
  401, 'INVALID_PROOF', 'Request timestamp is missing or outside the allowed clock window.');
  requireCondition(typeof nonce === 'string' && /^[A-Za-z0-9_-]{43}$/.test(nonce) &&
    typeof signature === 'string' && /^[A-Za-z0-9_-]{80,110}$/.test(signature),
  401, 'INVALID_PROOF', 'A signed installation proof is required.');
  let valid = false;
  try {
    valid = verify('sha256', Buffer.from(signingMessage({ ...request, timestamp, nonce, token })),
      publicKey, Buffer.from(signature, 'base64url'));
  } catch { /* Keep key and parsing details out of the response. */ }
  requireCondition(valid, 401, 'INVALID_PROOF', 'The request signature is invalid.');
  return nonce;
}
