import type { KMSClient } from '@aws-sdk/client-kms';
import { EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';

/**
 * Encrypt an RTSP URL using KMS. Falls back to base64 passthrough when no KMS key is configured (test/dev).
 */
export async function encryptRtspUrl(
  kms: KMSClient,
  keyId: string,
  plaintext: string,
): Promise<string> {
  if (!keyId) {
    return Buffer.from(plaintext, 'utf8').toString('base64');
  }

  const result = await kms.send(
    new EncryptCommand({
      KeyId: keyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
    }),
  );

  if (!result.CiphertextBlob) {
    throw new Error('KMS Encrypt returned no ciphertext');
  }

  return Buffer.from(result.CiphertextBlob).toString('base64');
}

/**
 * Decrypt an RTSP URL using KMS. Falls back to base64 passthrough when no KMS key is configured (test/dev).
 */
export async function decryptRtspUrl(
  kms: KMSClient,
  keyId: string,
  ciphertext: string,
): Promise<string> {
  if (!keyId) {
    return Buffer.from(ciphertext, 'base64').toString('utf8');
  }

  const result = await kms.send(
    new DecryptCommand({
      CiphertextBlob: Buffer.from(ciphertext, 'base64'),
    }),
  );

  if (!result.Plaintext) {
    throw new Error('KMS Decrypt returned no plaintext');
  }

  return Buffer.from(result.Plaintext).toString('utf8');
}
