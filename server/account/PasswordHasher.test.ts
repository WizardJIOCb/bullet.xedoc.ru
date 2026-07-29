import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './PasswordHasher.ts';

describe('PasswordHasher', () => {
  it('stores a versioned scrypt digest and verifies it in constant-length form', async () => {
    const hasher = new PasswordHasher({
      pepper: 'test-pepper',
      cost: 1_024,
      randomBytes: (size) => Buffer.alloc(size, 0x5a),
    });
    const encoded = await hasher.hash('ion-drive-password');

    expect(encoded).toMatch(/^scrypt\$1\$1024\$8\$1\$/);
    expect(encoded).not.toContain('ion-drive-password');
    await expect(hasher.verify('ion-drive-password', encoded)).resolves.toBe(true);
    await expect(hasher.verify('wrong-password', encoded)).resolves.toBe(false);
  });

  it('rejects malformed hashes after doing dummy work', async () => {
    const hasher = new PasswordHasher({ pepper: 'test-pepper', cost: 1_024 });
    await expect(hasher.verify('anything-long-enough', 'plaintext')).resolves.toBe(false);
  });
});
