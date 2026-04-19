// On-chain capture. For each recipe run we fetch the receipt DAGs for
// every broadcast tx (yield + resume for basic/chained; just yield for
// timeout), plus every block and chunk referenced by those DAGs. The
// result is written as `run-NN.onchain.json` alongside the raw artifact.
//
// Why capture locally at all: FastNEAR's archival retention is finite;
// runs captured today remain reanalyzable from the local JSON even if
// the endpoint ages them out. The tx hashes remain the independent-
// verification handle via public block explorers; the local capture is
// the convenience handle.
//
// Unlike the earlier thesis-demo capture, there is no `stateSeries` here.
// Recipes don't probe a third-party contract's state — their observable
// effects are all in trace events embedded in the captured receipts.

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

export interface CapturedTx {
  role: string;
  hash: string;
  signer: string;
}

export interface OnchainCapture {
  capturedAt: string;
  network: "testnet" | "mainnet";
  rpcEndpoints: { send: string; archival: string };
  chainId: string;
  protocolVersion: number | null;
  latestBlockAtCaptureHeight: number | null;

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
    process.stderr.write(`[capture]   txStatus ${hash.slice(0, 10)}: ${(e as Error).message}\n`);
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

export async function captureOnChain(txs: CapturedTx[]): Promise<OnchainCapture> {
  const status = await fetchStatus(RPC_AUDIT).catch(() => null);

  // Per-role tx DAGs.
  const txStatusByRole: Record<string, TxStatusResult | null> = {};
  for (const t of txs) {
    txStatusByRole[t.role] = await safeTxStatus(t.hash, t.signer);
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
      process.stderr.write(`[capture]   block ${h.slice(0, 10)}: ${(e as Error).message}\n`);
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
        process.stderr.write(`[capture]   chunk ${chunkMeta.chunk_hash.slice(0, 10)}: ${(e as Error).message}\n`);
      }
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    network: NEAR_NETWORK,
    rpcEndpoints: { send: RPC_SEND, archival: RPC_AUDIT },
    chainId: status?.chain_id ?? "unknown",
    protocolVersion: status?.protocol_version ?? null,
    latestBlockAtCaptureHeight: status?.sync_info?.latest_block_height ?? null,
    txStatus: txStatusByRole,
    blocks,
    chunks,
  };
}

export function writeOnchainCapture(path: string, capture: OnchainCapture): void {
  writeFileSync(path, JSON.stringify(capture, null, 2));
}
