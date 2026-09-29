// Low-level Bitcoin helpers for the solo pool: hashing, serialization,
// targets and merkle branches.
//
// Byte order notes: hashes are handled as Buffers in *internal* order (the
// order sha256d produces). Bitcoin Core's RPC shows block hashes and txids in
// *display* order, which is the reverse.

import crypto from "node:crypto";

export function sha256d(data: Buffer): Buffer {
  return crypto.createHash("sha256").update(crypto.createHash("sha256").update(data).digest()).digest();
}

export function reverse(buf: Buffer): Buffer {
  return Buffer.from(buf).reverse();
}

// Display-order hex (as RPC shows txids/block hashes) -> internal-order bytes.
export function fromDisplayHex(hex: string): Buffer {
  return reverse(Buffer.from(hex, "hex"));
}

export function le32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

export function le64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export function varint(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xff;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

// Minimal script push for data up to 75 bytes (all the pool ever needs).
export function pushData(data: Buffer): Buffer {
  if (data.length > 75) throw new Error("pushData only supports up to 75 bytes");
  return Buffer.concat([Buffer.from([data.length]), data]);
}

// BIP34: the coinbase scriptSig must start with the block height as a
// minimally encoded CScriptNum push.
export function scriptNumPush(n: number): Buffer {
  if (n === 0) return Buffer.from([0x00]); // OP_0
  if (n >= 1 && n <= 16) return Buffer.from([0x50 + n]); // OP_1..OP_16
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  // If the top bit is set it would read as negative; add a sign byte.
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0x00);
  return pushData(Buffer.from(bytes));
}

// Compact "bits" -> 256-bit target.
export function bitsToTarget(bits: number): bigint {
  const exponent = bits >>> 24;
  const mantissa = BigInt(bits & 0x007fffff);
  return exponent <= 3 ? mantissa >> BigInt(8 * (3 - exponent)) : mantissa << BigInt(8 * (exponent - 3));
}

export const MAX_TARGET = (1n << 256n) - 1n;
// Target for difficulty 1 (the pool-share convention used by all miners).
export const DIFF1_TARGET = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;

export function difficultyToTarget(difficulty: number): bigint {
  if (difficulty <= 0) return MAX_TARGET;
  // Scale to keep precision for fractional difficulties.
  const scaled = BigInt(Math.round(difficulty * 1e8));
  if (scaled === 0n) return MAX_TARGET;
  const target = (DIFF1_TARGET * 100_000_000n) / scaled;
  return target > MAX_TARGET ? MAX_TARGET : target;
}

// A header hash (internal byte order) read as the little-endian number that
// is compared against the target.
export function hashToBigInt(hash: Buffer): bigint {
  return BigInt("0x" + reverse(hash).toString("hex"));
}

export function hashDifficulty(hash: Buffer): number {
  const value = hashToBigInt(hash);
  if (value === 0n) return Number.MAX_VALUE;
  // Divide in two steps to keep precision for big ratios.
  return Number((DIFF1_TARGET * 1_000_000n) / value) / 1_000_000;
}

// Merkle branch ("steps") for the coinbase at index 0, as used by stratum:
// the miner computes root = sha256d(root + step) for each step in order.
export function merkleSteps(txHashes: Buffer[]): Buffer[] {
  const steps: Buffer[] = [];
  let level: (Buffer | null)[] = [null, ...txHashes];
  while (level.length > 1) {
    steps.push(level[1] as Buffer);
    if (level.length % 2) level.push(level[level.length - 1]);
    const next: (Buffer | null)[] = [null];
    for (let i = 2; i < level.length; i += 2) {
      next.push(sha256d(Buffer.concat([level[i] as Buffer, level[i + 1] as Buffer])));
    }
    level = next;
  }
  return steps;
}

export function merkleRootFromSteps(coinbaseHash: Buffer, steps: Buffer[]): Buffer {
  let root = coinbaseHash;
  for (const step of steps) root = sha256d(Buffer.concat([root, step]));
  return root;
}

// Plain merkle root over a full list of hashes (used to double-check steps).
export function merkleRoot(hashes: Buffer[]): Buffer {
  let level = hashes;
  while (level.length > 1) {
    if (level.length % 2) level = [...level, level[level.length - 1]];
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(Buffer.concat([level[i], level[i + 1]])));
    level = next;
  }
  return level[0];
}

// Stratum sends the previous block hash as eight 4-byte words, each word
// byte-swapped relative to the internal order.
export function prevHashForStratum(prevHashInternal: Buffer): string {
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i += 4) {
    out.writeUInt32BE(prevHashInternal.readUInt32LE(i), i);
  }
  return out.toString("hex");
}

export function buildHeader(opts: {
  version: number;
  prevHash: Buffer; // internal order
  merkleRoot: Buffer; // internal order
  time: number;
  bits: number;
  nonce: number;
}): Buffer {
  return Buffer.concat([
    le32(opts.version),
    opts.prevHash,
    opts.merkleRoot,
    le32(opts.time),
    le32(opts.bits),
    le32(opts.nonce),
  ]);
}
