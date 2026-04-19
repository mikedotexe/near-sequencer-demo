// On-chain snapshot. For each recipe run we fetch the receipt DAGs for
// every broadcast tx (yield + resume for basic/chained; just yield for
// timeout), plus every block and chunk referenced by those DAGs. The
// result is written as `run-NN.onchain.json` alongside the raw artifact.
//
// Why snapshot locally at all: FastNEAR's archival retention is finite;
// runs snapshotted today remain reanalyzable from the local JSON even
// if the endpoint ages them out. The tx hashes remain the independent-
// verification handle via public block explorers; the local snapshot is
// the convenience handle.
//
// The sibling smart-account-contract uses "snapshot" for the on-chain
// view frozen at a point in time; we borrow that vocabulary here so the
// two repos read cleanly together.

import { writeFileSync } from "node:fs";

import { NEAR_NETWORK, RPC_AUDIT, RPC_SEND } from "./config.js";
import {
  blockByHash,
  chunkByHash,
  fetchStatus,
  txStatus,
  type BlockResult,
  type ChunkResult,
  type TxStatusResult,
} from "./rpc.js";

export interface SnapshotTx {
  role: string;
  hash: string;
  signer: string;
}

// Aggregate snapshot health, so a stale "n/a" cell downstream can be
// told apart from "not applicable" (fine) vs "RPC gave up" (which the
// reader should know about).
//   complete — every txStatus / block / chunk fetch succeeded
//   partial  — some non-yield fetches failed; audit still runs but
//              some derived fields may be null
//   failed   — the yield tx itself couldn't be fetched; the audit can't
//              reconstruct the lifecycle from this snapshot
export interface SnapshotStatus {
  overall: "complete" | "partial" | "failed";
  txStatusFailures: string[]; // role names whose txStatus returned null
  blockFailures: string[]; // block hashes whose fetch threw
  chunkFailures: string[]; // chunk hashes whose fetch threw
}

export interface OnchainSnapshot {
  snapshotAt: string;
  network: "testnet" | "mainnet";
  rpcEndpoints: { send: string; archival: string };
  chainId: string;
  protocolVersion: number | null;
  latestBlockAtSnapshotHeight: number | null;

  // See SnapshotStatus above. Fields in older on-disk snapshots may be
  // missing; consumers should default a missing snapshotStatus to
  // { overall: "complete", ...: [] } for backward compatibility.
  snapshotStatus: SnapshotStatus;

  // tx DAGs keyed by role (e.g. "yield", "resume"). Recipes use stable
  // role names so the audit can reconstruct lifecycle regardless of
  // run-to-run tx-hash variance.
  txStatus: Record<string, TxStatusResult | null>;

  // Full block/chunk data keyed by hash. The auditor derives heights and
  // ordering from here without additional RPC calls.
  blocks: Record<string, BlockResult>;
  chunks: Record<string, ChunkResult>;
}

async function safeTxStatus(hash: string, signer: string): Promise<TxStatusResult | null> {
  try {
    return await txStatus(hash, signer);
  } catch (e) {
    process.stderr.write(`[snapshot]   txStatus ${hash.slice(0, 10)}: ${(e as Error).message}\n`);
    return null;
  }
}

function collectBlockHashesFromTx(tx: TxStatusResult, out: Set<string>): void {
  out.add(tx.transaction_outcome.block_hash);
  for (const o of tx.receipts_outcome) out.add(o.block_hash);
}

function collectReceiptIdsFromTx(tx: TxStatusResult, out: Set<string>): void {
  for (const r of tx.receipts) out.add(r.receipt_id);
  for (const o of tx.receipts_outcome) out.add(o.id);
}

export async function snapshotOnChain(txs: SnapshotTx[]): Promise<OnchainSnapshot> {
  const status = await fetchStatus(RPC_AUDIT).catch(() => null);

  const txStatusFailures: string[] = [];
  const blockFailures: string[] = [];
  const chunkFailures: string[] = [];

  // Per-role tx DAGs.
  const txStatusByRole: Record<string, TxStatusResult | null> = {};
  for (const t of txs) {
    const result = await safeTxStatus(t.hash, t.signer);
    txStatusByRole[t.role] = result;
    if (result === null) txStatusFailures.push(t.role);
  }

  // Collect block hashes and receipt IDs referenced by any DAG.
  const blockHashes = new Set<string>();
  const interestingReceiptIds = new Set<string>();
  for (const tx of Object.values(txStatusByRole)) {
    if (!tx) continue;
    collectBlockHashesFromTx(tx, blockHashes);
    collectReceiptIdsFromTx(tx, interestingReceiptIds);
  }

  // Fetch blocks.
  const blocks: Record<string, BlockResult> = {};
  for (const h of blockHashes) {
    try {
      blocks[h] = await blockByHash(h);
    } catch (e) {
      process.stderr.write(`[snapshot]   block ${h.slice(0, 10)}: ${(e as Error).message}\n`);
      blockFailures.push(h);
    }
  }

  // Fetch chunks containing at least one receipt we care about, or one of
  // our broadcast txs. Chunks let us compute receipt-ordinal ordering
  // offline if we ever want to inspect intra-block ordering.
  const chunks: Record<string, ChunkResult> = {};
  for (const block of Object.values(blocks)) {
    for (const chunkMeta of block.chunks) {
      if (chunks[chunkMeta.chunk_hash]) continue;
      try {
        const chunk = await chunkByHash(chunkMeta.chunk_hash);
        const hasInteresting = chunk.receipts.some((r) => interestingReceiptIds.has(r.receipt_id));
        const hasTx = chunk.transactions.some((t) => txs.some((x) => x.hash === t.hash));
        if (hasInteresting || hasTx) {
          chunks[chunkMeta.chunk_hash] = chunk;
        }
      } catch (e) {
        process.stderr.write(`[snapshot]   chunk ${chunkMeta.chunk_hash.slice(0, 10)}: ${(e as Error).message}\n`);
        chunkFailures.push(chunkMeta.chunk_hash);
      }
    }
  }

  // yield is the audit's root; any other failure is recoverable-ish.
  const overall: SnapshotStatus["overall"] = txStatusFailures.includes("yield")
    ? "failed"
    : txStatusFailures.length + blockFailures.length + chunkFailures.length > 0
      ? "partial"
      : "complete";

  return {
    snapshotAt: new Date().toISOString(),
    network: NEAR_NETWORK,
    rpcEndpoints: { send: RPC_SEND, archival: RPC_AUDIT },
    chainId: status?.chain_id ?? "unknown",
    protocolVersion: status?.protocol_version ?? null,
    latestBlockAtSnapshotHeight: status?.sync_info?.latest_block_height ?? null,
    snapshotStatus: { overall, txStatusFailures, blockFailures, chunkFailures },
    txStatus: txStatusByRole,
    blocks,
    chunks,
  };
}

export function writeOnchainSnapshot(path: string, snapshot: OnchainSnapshot): void {
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}
