import crypto from 'node:crypto';
import type { EncryptedVaultEnvelope, VaultPayload } from '../shared/types.ts';

/**
 * Decrypts a browser-exported AES-256-GCM (PBKDF2-SHA256) vault envelope
 * or parses a plaintext VaultPayload JSON for headless ROUTER_VAULT_JSON startup.
 */
export function parseStartupVaultJson(
  rawJson: string,
  passphrase?: string
): VaultPayload | null {
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.format === 'relaygate-vault-v1') {
      const env = parsed as EncryptedVaultEnvelope;
      if (!passphrase) {
        console.warn(
          '[RelayGate] ROUTER_VAULT_JSON is encrypted, but neither ROUTER_VAULT_PASSPHRASE nor ROUTER_MASTER_KEY is set.'
        );
        return null;
      }
      const salt = Buffer.from(env.salt, 'base64');
      const iv = Buffer.from(env.iv, 'base64');
      const combined = Buffer.from(env.ciphertext, 'base64');
      if (combined.length < 17) return null;

      // WebCrypto AES-GCM appends the 16-byte authentication tag at the end of ciphertext
      const authTag = combined.subarray(combined.length - 16);
      const encryptedData = combined.subarray(0, combined.length - 16);

      const key = crypto.pbkdf2Sync(
        passphrase,
        salt,
        env.iterations || 210000,
        32,
        'sha256'
      );
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]).toString('utf8');

      const vault = JSON.parse(decrypted) as VaultPayload;
      if (vault && Array.isArray(vault.keys)) {
        return vault;
      }
      return null;
    }

    // Plaintext VaultPayload support for simple headless setups
    if (Array.isArray(parsed.keys)) {
      return {
        version: 1,
        updatedAt: parsed.updatedAt || Date.now(),
        keys: parsed.keys,
        customEndpoints: Array.isArray(parsed.customEndpoints)
          ? parsed.customEndpoints
          : [],
        customModels:
          parsed.customModels && typeof parsed.customModels === 'object'
            ? parsed.customModels
            : {},
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        defaultStrategy: parsed.defaultStrategy || 'auto',
      };
    }

    return null;
  } catch (err) {
    console.error('[RelayGate] Failed to parse ROUTER_VAULT_JSON:', err instanceof Error ? err.message : err);
    return null;
  }
}
