// Mining jobs: turn a getblocktemplate result into stratum work, and turn a
// winning share back into a complete block for submitblock.

import {
  bitsToTarget,
  buildHeader,
  fromDisplayHex,
  le32,
  le64,
  merkleRootFromSteps,
  merkleSteps,
  prevHashForStratum,
  pushData,
  scriptNumPush,
  sha256d,
  varint,
} from "./bitcoin-utils.js";

export const EXTRANONCE1_SIZE = 4;
export const EXTRANONCE2_SIZE = 4;
const COINBASE_TAG = Buffer.from("/NovaEtherOS/");

export interface BlockTemplate {
  version: number;
  previousblockhash: string;
  transactions: { data: string; txid: string; hash: string; fee: number; weight: number }[];
  coinbasevalue: number;
  bits: string;
  height: number;
  curtime: number;
  mintime: number;
  default_witness_commitment?: string;
}

export interface Job {
  id: string;
  template: BlockTemplate;
  height: number;
  prevHash: Buffer; // internal order
  version: number;
  bits: number;
  networkTarget: bigint;
  curtime: number;
  mintime: number;
  coinb1: Buffer;
  coinb2: Buffer;
  merkleSteps: Buffer[];
  payoutScript: Buffer;
  hasWitness: boolean;
  createdAt: number;
}

// Coinbase serialized WITHOUT witness data, split around the extranonce so the
// miner can insert extranonce1 + extranonce2 in the middle:
//   coinb1 | extranonce1 | extranonce2 | coinb2
function coinbaseParts(t: BlockTemplate, payoutScript: Buffer) {
  const heightPush = scriptNumPush(t.height);
  const extranonceLen = EXTRANONCE1_SIZE + EXTRANONCE2_SIZE;
  const tagPush = pushData(COINBASE_TAG);
  // scriptSig = <height> <push 8 bytes: extranonce> <tag>
  const scriptSigLen = heightPush.length + 1 + extranonceLen + tagPush.length;

  const coinb1 = Buffer.concat([
    le32(2), // tx version
    varint(1), // one input
    Buffer.alloc(32), // prevout hash: null
    Buffer.from("ffffffff", "hex"), // prevout index
    varint(scriptSigLen),
    heightPush,
    Buffer.from([extranonceLen]), // push opcode for the extranonce bytes
  ]);

  const outputs = [Buffer.concat([le64(t.coinbasevalue), varint(payoutScript.length), payoutScript])];
  if (t.default_witness_commitment) {
    const commitment = Buffer.from(t.default_witness_commitment, "hex");
    outputs.push(Buffer.concat([le64(0), varint(commitment.length), commitment]));
  }

  const coinb2 = Buffer.concat([
    tagPush,
    Buffer.from("ffffffff", "hex"), // sequence
    varint(outputs.length),
    ...outputs,
    le32(0), // locktime
  ]);

  return { coinb1, coinb2 };
}

export function createJob(id: string, t: BlockTemplate, payoutScript: Buffer): Job {
  const { coinb1, coinb2 } = coinbaseParts(t, payoutScript);
  const bits = parseInt(t.bits, 16);
  return {
    id,
    template: t,
    height: t.height,
    prevHash: fromDisplayHex(t.previousblockhash),
    version: t.version,
    bits,
    networkTarget: bitsToTarget(bits),
    curtime: t.curtime,
    mintime: t.mintime,
    coinb1,
    coinb2,
    // Merkle branches use txids (not wtxids); the witness root is committed
    // separately in the coinbase via default_witness_commitment.
    merkleSteps: merkleSteps(t.transactions.map((tx) => fromDisplayHex(tx.txid))),
    payoutScript,
    hasWitness: Boolean(t.default_witness_commitment),
    createdAt: Date.now(),
  };
}

// mining.notify params (without clean_jobs).
export function notifyParams(job: Job) {
  return [
    job.id,
    prevHashForStratum(job.prevHash),
    job.coinb1.toString("hex"),
    job.coinb2.toString("hex"),
    job.merkleSteps.map((s) => s.toString("hex")),
    job.version.toString(16).padStart(8, "0"),
    job.bits.toString(16).padStart(8, "0"),
    job.curtime.toString(16).padStart(8, "0"),
  ];
}

export function coinbaseTx(job: Job, extranonce1: Buffer, extranonce2: Buffer) {
  return Buffer.concat([job.coinb1, extranonce1, extranonce2, job.coinb2]);
}

export function headerFor(
  job: Job,
  extranonce1: Buffer,
  extranonce2: Buffer,
  time: number,
  nonce: number,
  version: number,
) {
  const coinbase = coinbaseTx(job, extranonce1, extranonce2);
  const root = merkleRootFromSteps(sha256d(coinbase), job.merkleSteps);
  const header = buildHeader({ version, prevHash: job.prevHash, merkleRoot: root, time, bits: job.bits, nonce });
  return { header, coinbase, hash: sha256d(header) };
}

// Full block: header + tx count + coinbase (with witness if needed) + template txs.
export function serializeBlock(job: Job, header: Buffer, coinbase: Buffer): Buffer {
  let coinbaseFull = coinbase;
  if (job.hasWitness) {
    // Insert segwit marker+flag after the version, and the coinbase witness
    // (one 32-byte zero "witness reserved value") before the locktime.
    coinbaseFull = Buffer.concat([
      coinbase.subarray(0, 4),
      Buffer.from([0x00, 0x01]),
      coinbase.subarray(4, coinbase.length - 4),
      Buffer.from([0x01, 0x20]),
      Buffer.alloc(32),
      coinbase.subarray(coinbase.length - 4),
    ]);
  }
  return Buffer.concat([
    header,
    varint(job.template.transactions.length + 1),
    coinbaseFull,
    ...job.template.transactions.map((tx) => Buffer.from(tx.data, "hex")),
  ]);
}
