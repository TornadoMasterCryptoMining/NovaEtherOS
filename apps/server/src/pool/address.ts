// Bitcoin address -> output script (scriptPubKey), so the coinbase pays the
// miner's own address. Supports bech32 (P2WPKH/P2WSH), bech32m (P2TR) and
// base58 (P2PKH/P2SH).

import { sha256d } from "./bitcoin-utils.js";

export type Network = "main" | "test" | "signet" | "regtest";

const HRP: Record<Network, string> = { main: "bc", test: "tb", signet: "tb", regtest: "bcrt" };
const BASE58_VERSIONS: Record<Network, { p2pkh: number; p2sh: number }> = {
  main: { p2pkh: 0x00, p2sh: 0x05 },
  test: { p2pkh: 0x6f, p2sh: 0xc4 },
  signet: { p2pkh: 0x6f, p2sh: 0xc4 },
  regtest: { p2pkh: 0x6f, p2sh: 0xc4 },
};

// --- bech32 / bech32m (BIP173, BIP350) ------------------------------------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string) {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function bech32Decode(addr: string): { hrp: string; data: number[]; constant: number } | null {
  if (addr.length > 90) return null;
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return null; // mixed case
  const pos = lower.lastIndexOf("1");
  if (pos < 1 || pos + 7 > lower.length) return null;
  const hrp = lower.slice(0, pos);
  const data: number[] = [];
  for (const c of lower.slice(pos + 1)) {
    const d = CHARSET.indexOf(c);
    if (d === -1) return null;
    data.push(d);
  }
  const constant = polymod([...hrpExpand(hrp), ...data]);
  if (constant !== BECH32_CONST && constant !== BECH32M_CONST) return null;
  return { hrp, data: data.slice(0, -6), constant };
}

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  // No padding allowed when decoding.
  if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

function segwitScript(addr: string, network: Network): Buffer | null {
  const dec = bech32Decode(addr);
  if (!dec || dec.hrp !== HRP[network] || dec.data.length < 1) return null;
  const version = dec.data[0];
  if (version > 16) return null;
  const program = convertBits(dec.data.slice(1), 5, 8);
  if (!program || program.length < 2 || program.length > 40) return null;
  if (version === 0 && program.length !== 20 && program.length !== 32) return null;
  // v0 uses bech32; v1+ (taproot and later) use bech32m.
  if ((version === 0) !== (dec.constant === BECH32_CONST)) return null;
  const opVersion = version === 0 ? 0x00 : 0x50 + version;
  return Buffer.from([opVersion, program.length, ...program]);
}

// --- base58check ----------------------------------------------------------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(s: string): Buffer | null {
  let num = 0n;
  for (const c of s) {
    const d = B58.indexOf(c);
    if (d === -1) return null;
    num = num * 58n + BigInt(d);
  }
  let hex = num === 0n ? "" : num.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const leadingZeros = s.match(/^1*/)![0].length;
  return Buffer.concat([Buffer.alloc(leadingZeros), Buffer.from(hex, "hex")]);
}

function base58Script(addr: string, network: Network): Buffer | null {
  const raw = base58Decode(addr);
  if (!raw || raw.length !== 25) return null;
  const payload = raw.subarray(0, 21);
  if (!sha256d(payload).subarray(0, 4).equals(raw.subarray(21))) return null;
  const version = payload[0];
  const hash = payload.subarray(1);
  const v = BASE58_VERSIONS[network];
  if (version === v.p2pkh) return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);
  if (version === v.p2sh) return Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);
  return null;
}

// Returns the output script for `address`, or null if it isn't a valid
// address for `network`.
export function addressToScript(address: string, network: Network = "main"): Buffer | null {
  const a = address.trim();
  return segwitScript(a, network) ?? base58Script(a, network);
}
