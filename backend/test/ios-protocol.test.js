import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verify } from 'node:crypto';
import { signingMessage } from '../src/crypto.js';

test('shared iPhone interoperability vector matches the server signing contract', () => {
  // Only a disposable public key and one test signature are stored. No private key.
  const vector = JSON.parse(fs.readFileSync(new URL('./fixtures/request-proof.json', import.meta.url)));
  const bytes = Buffer.from(signingMessage({ ...vector, body: Buffer.from(vector.body) }));
  assert.equal(bytes.toString('base64'), vector.messageBase64);
  assert.ok(verify('sha256', bytes, vector.publicKey, Buffer.from(vector.signatureBase64, 'base64')));
});
