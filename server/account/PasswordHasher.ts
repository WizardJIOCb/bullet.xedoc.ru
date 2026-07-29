import { createHash, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto';
function scrypt(
  password: Buffer,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export interface PasswordCost {
  N: number;
  r: number;
  p: number;
  keyLength: number;
  maxmem: number;
}

export interface PasswordHasherOptions {
  pepper?: string;
  cost?: number | Partial<PasswordCost>;
  concurrency?: number;
  randomBytes?: (size: number) => Buffer;
}

const DEFAULT_COST: PasswordCost = {
  N: 32_768,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 64 * 1024 * 1024,
};

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function isPowerOfTwo(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1_024 && (value & (value - 1)) === 0;
}

function resolveCost(cost: PasswordHasherOptions['cost']): PasswordCost {
  const resolved = typeof cost === 'number'
    ? { ...DEFAULT_COST, N: cost }
    : { ...DEFAULT_COST, ...(cost ?? {}) };
  if (!isPowerOfTwo(resolved.N)) throw new TypeError('scrypt N must be a power of two >= 1024');
  if (!Number.isSafeInteger(resolved.r) || resolved.r < 1) throw new TypeError('scrypt r must be positive');
  if (!Number.isSafeInteger(resolved.p) || resolved.p < 1) throw new TypeError('scrypt p must be positive');
  if (!Number.isSafeInteger(resolved.keyLength) || resolved.keyLength < 16) {
    throw new TypeError('scrypt keyLength must be at least 16 bytes');
  }
  return resolved;
}

export class PasswordHasher {
  readonly cost: Readonly<PasswordCost>;

  private readonly pepper: Buffer;
  private readonly semaphore: Semaphore;
  private readonly random: (size: number) => Buffer;

  constructor(options: PasswordHasherOptions = {}) {
    this.cost = resolveCost(options.cost);
    this.pepper = Buffer.from(options.pepper ?? '', 'utf8');
    this.semaphore = new Semaphore(Math.max(1, Math.floor(options.concurrency ?? 2)));
    this.random = options.randomBytes ?? randomBytes;
  }

  async hash(password: string): Promise<string> {
    const salt = this.random(16);
    const derived = await this.derive(password, salt, this.cost);
    return [
      'scrypt',
      '1',
      String(this.cost.N),
      String(this.cost.r),
      String(this.cost.p),
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parsed = this.parse(encoded);
    if (!parsed) {
      await this.verifyDummy(password);
      return false;
    }
    const actual = await this.derive(password, parsed.salt, parsed.cost);
    return actual.length === parsed.expected.length && timingSafeEqual(actual, parsed.expected);
  }

  async verifyDummy(password: string): Promise<void> {
    const salt = createHash('sha256').update('ballistic-edge-auth-dummy-salt').digest().subarray(0, 16);
    await this.derive(password, salt, this.cost);
  }

  private passwordInput(password: string): Buffer {
    const value = Buffer.from(password.normalize('NFC'), 'utf8');
    return this.pepper.length === 0
      ? value
      : Buffer.concat([value, Buffer.from([0]), this.pepper]);
  }

  private async derive(password: string, salt: Buffer, cost: PasswordCost): Promise<Buffer> {
    return this.semaphore.use(async () => scrypt(
      this.passwordInput(password),
      salt,
      cost.keyLength,
      { N: cost.N, r: cost.r, p: cost.p, maxmem: cost.maxmem },
    ));
  }

  private parse(encoded: string): { cost: PasswordCost; salt: Buffer; expected: Buffer } | null {
    const parts = encoded.split('$');
    if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1') return null;
    const N = Number(parts[2]);
    const r = Number(parts[3]);
    const p = Number(parts[4]);
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[5], 'base64url');
      expected = Buffer.from(parts[6], 'base64url');
    } catch {
      return null;
    }
    if (!isPowerOfTwo(N) || !Number.isSafeInteger(r) || r < 1 || !Number.isSafeInteger(p) || p < 1) return null;
    if (salt.length < 8 || expected.length < 16 || expected.length > 128) return null;
    const maxmem = Math.max(DEFAULT_COST.maxmem, 128 * N * r + 1024 * 1024);
    return { cost: { N, r, p, keyLength: expected.length, maxmem }, salt, expected };
  }
}
