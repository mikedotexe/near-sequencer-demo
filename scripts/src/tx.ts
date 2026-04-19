import {
  Account,
  transactions as txns,
  type Near,
} from "near-api-js";
import { baseDecode } from "@near-js/utils";

import { MASTER_ACCOUNT_ID } from "./config.js";
import { sendRpc } from "./rpc.js";

// A tiny direct-send transaction helper that bypasses near-api-js's
// exponentialBackoff + accessKeyByPublicKeyCache. We manage nonce ourselves:
// fetch access key info once up front and increment for each tx. This avoids
// the InvalidNonce retry storm seen when FastNEAR's load balancer returns an
// access key view that lags behind the actual chain head.

export interface DirectSender {
  accountId: string;
  broadcastFunctionCall: (receiverId: string, methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint) => Promise<string>;
}

export async function makeDirectSender(near: Near, accountId: string = MASTER_ACCOUNT_ID): Promise<DirectSender> {
  const account: Account = await near.account(accountId);
  const connection = account.connection;
  const provider = connection.provider;
  const signer = connection.signer;

  const publicKey = await signer.getPublicKey(accountId, connection.networkId);
  if (!publicKey) {
    throw new Error(`no public key for ${accountId} on ${connection.networkId}`);
  }
  const pkString = publicKey.toString();

  // Fetch the access key's current nonce ONCE.
  const accessKeyInfo = await provider.query<{ nonce: number | string | bigint; block_hash: string; block_height: number }>({
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: pkString,
  });
  let nextNonce = BigInt(accessKeyInfo.nonce) + 1n;

  async function freshBlockHash(): Promise<Uint8Array> {
    const block = await provider.block({ finality: "final" });
    return baseDecode(block.header.hash);
  }

  // Fire-and-forget: returns the tx hash after the node accepts the tx. Does
  // not wait for execution. `broadcast_tx_async` takes ~200ms vs ~100s for
  // wait_until-flavored send_tx on FastNEAR.
  async function broadcastFunctionCall(
    receiverId: string,
    methodName: string,
    args: Record<string, unknown>,
    gas: bigint,
    deposit: bigint,
  ): Promise<string> {
    const nonce = nextNonce;
    nextNonce += 1n;
    const blockHash = await freshBlockHash();
    const action = txns.functionCall(
      methodName,
      new Uint8Array(Buffer.from(JSON.stringify(args))),
      gas,
      deposit,
    );
    const [, signedTx] = await txns.signTransaction(
      receiverId,
      nonce,
      [action],
      blockHash,
      signer,
      accountId,
      connection.networkId,
    );
    const txBytes = signedTx.encode();
    const txBase64 = Buffer.from(txBytes).toString("base64");
    return sendRpc<string>("broadcast_tx_async", [txBase64]);
  }

  return { accountId, broadcastFunctionCall };
}
