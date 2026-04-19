import { connect, keyStores, type Near, type Account } from "near-api-js";

import {
  CREDENTIALS_DIR,
  EXPECTED_CHAIN_ID,
  FASTNEAR_API_KEY,
  MASTER_ACCOUNT_ID,
  NEAR_NETWORK,
  RPC_AUDIT,
  RPC_SEND,
} from "./config.js";

// FastNEAR accepts both `Authorization: Bearer <key>` header and `?apiKey=<key>`
// query param. Their docs recommend the header for production. We attach it
// to every JSON-RPC POST; if no key is set the header is omitted and we hit
// the free tier (fine for public methods and small experiments).
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (FASTNEAR_API_KEY) {
    h["Authorization"] = `Bearer ${FASTNEAR_API_KEY}`;
  }
  return h;
}

export type JsonRpcError = { code: number; message: string; data?: unknown };

export class RpcError extends Error {
  public readonly code: number;
  public readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(`RPC ${code}: ${message}${data !== undefined ? ` — ${JSON.stringify(data)}` : ""}`);
    this.code = code;
    this.data = data;
    this.name = "RpcError";
  }
}

function dataAsString(data: unknown): string {
  if (typeof data === "string") return data;
  if (data && typeof data === "object") return JSON.stringify(data);
  return "";
}

function isTransient(err: RpcError): boolean {
  // NEAR JSON-RPC puts the interesting detail in `data`. -32000 with a name-level
  // error like "AccountDoesNotExist" or "UNKNOWN_TRANSACTION" is permanent; only
  // a few strings mean the node is actually overloaded.
  const dataStr = dataAsString(err.data).toLowerCase();
  const msg = err.message.toLowerCase();
  if (/overload|timeout|too\s+busy|too\s+many\s+requests/.test(msg + " " + dataStr)) return true;
  if (/does\s+not\s+exist|unknown_account|accountdoesnotexist|unknown_transaction|unknown_receipt|unknown_block|unknown_chunk/.test(msg + " " + dataStr)) {
    return false;
  }
  // Default: do not retry on -32000 to avoid masking permanent errors.
  return false;
}

async function rpcCall<T>(url: string, method: string, params: unknown): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "demo", method, params });
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(),
        body,
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (attempt === maxAttempts) break;
        const backoffMs = Math.min(8000, 250 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      const json = (await res.json()) as { result?: T; error?: JsonRpcError };
      if (json.error) {
        const err = new RpcError(json.error.code, json.error.message, json.error.data);
        if (!isTransient(err) || attempt === maxAttempts) throw err;
        lastErr = err;
        const backoffMs = Math.min(8000, 250 * 2 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      if (!("result" in json) || json.result === undefined) {
        throw new Error("RPC response missing result");
      }
      return json.result;
    } catch (e) {
      if (e instanceof RpcError) throw e;
      lastErr = e;
      if (attempt === maxAttempts) break;
      const backoffMs = Math.min(8000, 250 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function auditRpc<T>(method: string, params: unknown): Promise<T> {
  return rpcCall<T>(RPC_AUDIT, method, params);
}

export async function sendRpc<T>(method: string, params: unknown): Promise<T> {
  return rpcCall<T>(RPC_SEND, method, params);
}

// near-api-js's provider uses its own fetch path and doesn't expose header
// customization cleanly, so we thread the FastNEAR key via the query-param
// form (`?apiKey=...`). FastNEAR's docs explicitly support both forms with
// the same key. Our own JSON-RPC calls in this module use the header form;
// both coexist.
function withApiKey(url: string): string {
  if (!FASTNEAR_API_KEY) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}apiKey=${encodeURIComponent(FASTNEAR_API_KEY)}`;
}

export async function connectSender(): Promise<Near> {
  // UnencryptedFileSystemKeyStore reads lazily per (networkId, accountId) lookup,
  // so any subaccount credentialed mid-session by `near create-account` is picked
  // up without reconnecting.
  const keyStore = new keyStores.UnencryptedFileSystemKeyStore(CREDENTIALS_DIR);
  return connect({
    networkId: NEAR_NETWORK,
    nodeUrl: withApiKey(RPC_SEND),
    keyStore,
  });
}

// Chain-id guard: before any mainnet broadcast, call this and let it panic if
// the RPC endpoint's reported chain_id does not match the configured network.
// Catches the classic "pointed testnet script at mainnet" (or vice versa) bug
// before we sign a tx on the wrong chain.
interface RpcStatus {
  chain_id: string;
  protocol_version?: number;
  version?: { version: string; build: string };
  sync_info?: { latest_block_height: number; latest_block_hash: string };
}

export async function fetchStatus(url: string = RPC_SEND): Promise<RpcStatus> {
  return rpcCall<RpcStatus>(url, "status", []);
}

export async function assertChainIdMatches(): Promise<RpcStatus> {
  const status = await fetchStatus(RPC_SEND);
  if (status.chain_id !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Chain-id mismatch: RPC ${RPC_SEND} reports chain_id="${status.chain_id}" ` +
        `but NEAR_NETWORK=${NEAR_NETWORK} expects "${EXPECTED_CHAIN_ID}". ` +
        `Refusing to proceed — check your RPC_SEND / NEAR_NETWORK combination.`,
    );
  }
  return status;
}

export async function accountFor(near: Near, accountId: string): Promise<Account> {
  return near.account(accountId);
}

export async function masterAccount(near: Near): Promise<Account> {
  return near.account(MASTER_ACCOUNT_ID);
}

// Wait for a transaction's receipt DAG to reach the requested finality
// level and return the full status. Default FINAL waits for the whole
// receipt DAG to finalize — for yielded transactions this can mean
// waiting up to 200 blocks (for the yielded callback), so callers that
// just need tx inclusion (e.g., to read the yield block height) should
// pass "EXECUTED_OPTIMISTIC" or "INCLUDED".
export async function txStatus(
  txHash: string,
  senderId: string,
  waitUntil: "NONE" | "INCLUDED" | "EXECUTED_OPTIMISTIC" | "EXECUTED" | "FINAL" = "FINAL",
): Promise<TxStatusResult> {
  return auditRpc<TxStatusResult>("EXPERIMENTAL_tx_status", {
    tx_hash: txHash,
    sender_account_id: senderId,
    wait_until: waitUntil,
  });
}

export async function blockByHash(blockHash: string): Promise<BlockResult> {
  return auditRpc<BlockResult>("block", { block_id: blockHash });
}

export async function blockByHeight(height: number): Promise<BlockResult> {
  return auditRpc<BlockResult>("block", { block_id: height });
}

export async function chunkByHash(chunkHash: string): Promise<ChunkResult> {
  return auditRpc<ChunkResult>("chunk", { chunk_id: chunkHash });
}

// Call a view method at a specific block height, decoding the JSON result.
export async function viewAtBlock<T = unknown>(
  accountId: string,
  methodName: string,
  args: Record<string, unknown>,
  blockId: number | string | "final",
): Promise<T> {
  const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
  const params: Record<string, unknown> = {
    request_type: "call_function",
    account_id: accountId,
    method_name: methodName,
    args_base64: argsBase64,
  };
  if (blockId === "final") {
    params.finality = "final";
  } else {
    params.block_id = blockId;
  }
  const result = await auditRpc<{ result: number[]; block_height: number; block_hash: string }>(
    "query",
    params,
  );
  const buf = Buffer.from(result.result);
  return JSON.parse(buf.toString("utf8")) as T;
}

export async function accountExists(accountId: string): Promise<boolean> {
  try {
    await auditRpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return true;
  } catch (e) {
    if (e instanceof RpcError) {
      const payload = (dataAsString(e.data) + " " + e.message).toLowerCase();
      if (/does\s+not\s+exist|unknown_account|accountdoesnotexist/.test(payload)) return false;
    }
    const msg = (e as Error).message ?? "";
    if (/does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(msg)) return false;
    throw e;
  }
}

// Types. Only the fields we use are kept strict; the rest are unknown.

export interface ReceiptOutcomeEntry {
  id: string;
  outcome: {
    logs: string[];
    receipt_ids: string[];
    gas_burnt: number;
    status:
      | { SuccessValue: string }
      | { SuccessReceiptId: string }
      | { Failure: unknown }
      | { Unknown: unknown };
    executor_id: string;
  };
  block_hash: string;
}

export interface ReceiptEntry {
  predecessor_id: string;
  receiver_id: string;
  receipt_id: string;
  receipt?: {
    Action?: {
      actions: Array<
        | { FunctionCall: { method_name: string; args: string } }
        | Record<string, unknown>
      >;
    };
  };
}

export interface TxStatusResult {
  status: Record<string, unknown>;
  transaction: { hash: string; signer_id: string; receiver_id: string };
  transaction_outcome: ReceiptOutcomeEntry;
  receipts_outcome: ReceiptOutcomeEntry[];
  receipts: ReceiptEntry[];
  final_execution_status?: string;
}

export interface BlockResult {
  header: { height: number; hash: string; timestamp: number; timestamp_nanosec: string };
  chunks: Array<{ chunk_hash: string; shard_id: number; height_created: number }>;
}

export interface ChunkResult {
  header: { chunk_hash: string; shard_id: number; height_created: number };
  receipts: Array<ReceiptEntry>;
  transactions: Array<{ hash: string; signer_id: string; receiver_id: string }>;
}
