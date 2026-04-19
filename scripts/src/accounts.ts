import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, transactions, utils } from "near-api-js";

import {
  ACCOUNTS,
  ARTIFACTS_DIR,
  BOB_ACCOUNT_ID,
  BOB_INITIAL_BALANCE_NEAR,
  INITIAL_BALANCE_NEAR,
  MASTER_ACCOUNT_ID,
  NEAR_NETWORK,
  NETWORK_CREDENTIALS_DIR,
  REPO_ROOT,
  WASM_PATHS,
  type AccountKey,
} from "./config.js";
import { accountExists, connectSender } from "./rpc.js";

// NEAR's "no contract deployed" sentinel: the code_hash of an account
// without any wasm. Base58 of 32 zero bytes — looks like 32 ones in
// string form because near-api-js encodes it that way.
const EMPTY_CODE_HASH = "11111111111111111111111111111111";

// The `recipes` contract's `new()` takes an `owner_id` that gates the
// four `recipe_*_yield` methods. Set to MASTER_ACCOUNT_ID so the demo
// master (who signs all broadcast txs) is authorized to yield while
// anyone else is blocked at the contract boundary. Resume methods
// stay permissionless by design — Recipe 4's "anyone can pull the
// trigger" is a teaching claim. Closes the mainnet state-abuse
// vector documented in docs/mainnet-readiness.md.
//
// The `counter` contract has no owner — it's the canonical NEAR
// counter and takes no init parameters.
const INIT_ARGS: Record<AccountKey, Record<string, unknown>> = {
  recipes: { owner_id: MASTER_ACCOUNT_ID },
  counter: {},
};

function parseNearToYocto(near: string): bigint {
  const parsed = utils.format.parseNearAmount(near);
  if (!parsed) throw new Error(`failed to parse NEAR amount: ${near}`);
  return BigInt(parsed);
}

function credentialPath(accountId: string): string {
  return join(NETWORK_CREDENTIALS_DIR, `${accountId}.json`);
}

// Fail loud with a clear message if the master account's key is missing
// from the network-specific credentials directory. Better than a cryptic
// signing error deep inside near-api-js.
export function assertMasterCredentialPresent(): void {
  const path = credentialPath(MASTER_ACCOUNT_ID);
  if (!existsSync(path)) {
    throw new Error(
      `Missing credentials for ${MASTER_ACCOUNT_ID} on ${NEAR_NETWORK}: ` +
        `expected key file at ${path}. ` +
        `Create via \`near-cli-rs\` or similar and place the JSON there.`,
    );
  }
}

function writeCredential(accountId: string, keyPair: KeyPair): void {
  mkdirSync(NETWORK_CREDENTIALS_DIR, { recursive: true });
  const publicKey = keyPair.getPublicKey().toString();
  const privateKey = keyPair.toString();
  const json = { account_id: accountId, public_key: publicKey, private_key: privateKey };
  writeFileSync(credentialPath(accountId), JSON.stringify(json));
}

// Check whether the account has a contract deployed to it. Used to
// distinguish "fresh account, atomic create+deploy+init needed" from
// "contract already in place, just redeploy new wasm."
async function hasContract(accountId: string): Promise<boolean> {
  const near = await connectSender();
  const account = await near.account(accountId);
  try {
    const state = await account.state();
    return state.code_hash !== EMPTY_CODE_HASH;
  } catch {
    return false;
  }
}

// (Previous `ensureAccount` helper for recipes/counter was folded into
// `atomicCreateDeployInit`, which does create+deploy+init in one tx.
// Bob — a non-contract participant — still uses a separate create path
// below; `near-api-js`'s `createAccount` already batches the
// CreateAccount + Transfer + AddKey actions atomically, so there's no
// init-race equivalent to worry about on Bob's side.)

// Bob is a non-contract participant (Recipe 4's nominated recipient).
// He exists so the handoff's transfer lands on a real account with a
// watchable balance. We still give him a keypair at creation in case a
// future variant wants Bob to sign something — today the demo flow has
// Alice sign both yield and resume.
async function ensureBob(): Promise<"existed" | "created"> {
  if (await accountExists(BOB_ACCOUNT_ID)) return "existed";
  const near = await connectSender();
  const creator = await near.account(MASTER_ACCOUNT_ID);
  const keyPair = KeyPair.fromRandom("ed25519");
  writeCredential(BOB_ACCOUNT_ID, keyPair);
  const amount = parseNearToYocto(BOB_INITIAL_BALANCE_NEAR);
  await creator.createAccount(BOB_ACCOUNT_ID, keyPair.getPublicKey(), amount);
  return "created";
}

function wasmSha256(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(bytes).digest("hex");
}

// First-time deploy: the sub-account doesn't exist yet. We batch
// CreateAccount + Transfer + AddKey + DeployContract + FunctionCall(new)
// into a single atomic tx signed by the master. No front-running window
// between deploy and init, because there's no window at all — everything
// lands or nothing does. The master is authorized to CreateAccount on
// its own sub-account (name must be `.<master>` suffix), so the whole
// construction is internally consistent.
async function atomicCreateDeployInit(key: AccountKey): Promise<DeployRecord> {
  const accountId = ACCOUNTS[key];
  const wasmPath = join(REPO_ROOT, WASM_PATHS[key]);
  if (!existsSync(wasmPath)) {
    throw new Error(`wasm not found: ${wasmPath} (did you run demo.sh build?)`);
  }
  const sha = wasmSha256(wasmPath);
  const wasmBytes = readFileSync(wasmPath);

  const near = await connectSender();
  const master = await near.account(MASTER_ACCOUNT_ID);

  // Generate the sub-account's full-access keypair locally and write
  // it to credentials BEFORE broadcasting the tx. If the tx succeeds,
  // the credential file matches the on-chain AddKey action. If the tx
  // fails, we have a stray credential file; that's a cheap cleanup
  // (overwritten on the next attempt).
  const keyPair = KeyPair.fromRandom("ed25519");
  writeCredential(accountId, keyPair);

  const amount = parseNearToYocto(INITIAL_BALANCE_NEAR);
  const argsBytes = Buffer.from(JSON.stringify(INIT_ARGS[key]));
  const actions = [
    transactions.createAccount(),
    transactions.transfer(amount),
    transactions.addKey(keyPair.getPublicKey(), transactions.fullAccessKey()),
    transactions.deployContract(wasmBytes),
    transactions.functionCall("new", argsBytes, BigInt(60_000_000_000_000), 0n),
  ];

  const result = await master.signAndSendTransaction({
    receiverId: accountId,
    actions,
  });
  const txHash =
    result.transaction?.hash ?? result.transaction_outcome?.id ?? "unknown";

  return {
    key,
    accountId,
    created: true,
    wasmPath,
    wasmSha256: sha,
    wasmSize: wasmBytes.length,
    deployTxHash: txHash,
    initTxHash: txHash, // same atomic tx as the deploy
    initSkippedReason: null,
    timestamp: new Date().toISOString(),
  };
}

// Re-deploy: the account exists AND has a contract already. Upload
// new wasm; state is preserved by NEAR (no init call, since init
// would panic on existing state). Used when the same contract has
// been deployed and initialized before and the code is being
// refreshed without a full clean.
async function redeployOnly(key: AccountKey): Promise<DeployRecord> {
  const accountId = ACCOUNTS[key];
  const wasmPath = join(REPO_ROOT, WASM_PATHS[key]);
  if (!existsSync(wasmPath)) {
    throw new Error(`wasm not found: ${wasmPath} (did you run demo.sh build?)`);
  }
  const sha = wasmSha256(wasmPath);
  const wasmBytes = readFileSync(wasmPath);

  const near = await connectSender();
  const account = await near.account(accountId);
  const deployResult = await account.deployContract(wasmBytes);
  const deployTxHash =
    deployResult.transaction?.hash ??
    deployResult.transaction_outcome?.id ??
    "unknown";

  return {
    key,
    accountId,
    created: false,
    wasmPath,
    wasmSha256: sha,
    wasmSize: wasmBytes.length,
    deployTxHash,
    initTxHash: null,
    initSkippedReason: "already-initialized",
    timestamp: new Date().toISOString(),
  };
}

async function deployAndMaybeInit(key: AccountKey): Promise<DeployRecord> {
  const accountId = ACCOUNTS[key];
  const exists = await accountExists(accountId);
  if (!exists) {
    // Fresh deploy — atomic create+deploy+init; no front-run window.
    return await atomicCreateDeployInit(key);
  }
  const codeDeployed = await hasContract(accountId);
  if (!codeDeployed) {
    // Unusual: account exists but has no contract. Could mean a prior
    // deploy was partially completed (account created, wasm upload
    // failed) or the account was created out-of-band. We refuse
    // rather than silently re-init because the safest recovery is a
    // clean delete → atomic redeploy, not a sequence of partial
    // patches that might leave state half-set.
    throw new Error(
      `Account ${accountId} exists but has no contract deployed. ` +
        `To recover: run \`./scripts/demo.sh clean --i-know-this-is-${NEAR_NETWORK}\` ` +
        `to delete the account, then retry \`./scripts/demo.sh deploy\` for a ` +
        `fresh atomic create+deploy+init.`,
    );
  }
  // Contract exists and is assumed initialized. Just redeploy new wasm.
  return await redeployOnly(key);
}

export interface DeployRecord {
  key: AccountKey;
  accountId: string;
  created: boolean;
  wasmPath: string;
  wasmSha256: string;
  wasmSize: number;
  deployTxHash: string;
  initTxHash: string | null;
  initSkippedReason: string | null;
  timestamp: string;
}

// Both contracts are direct children of the master. Deploy order is
// [recipes, counter]; counter has no dependency on recipes, but keeping
// this order means the primary subject of study is visibly up first.
const DEPLOY_ORDER: AccountKey[] = ["recipes", "counter"];

export async function deployAll(): Promise<DeployRecord[]> {
  const records: DeployRecord[] = [];
  for (const key of DEPLOY_ORDER) {
    process.stderr.write(`[deploy] ${key} (${ACCOUNTS[key]})...\n`);
    const rec = await deployAndMaybeInit(key);
    process.stderr.write(
      `[deploy]   wasm=${rec.wasmSize}B sha256=${rec.wasmSha256.slice(0, 12)} deployTx=${rec.deployTxHash.slice(0, 12)} ` +
        `init=${rec.initTxHash ? rec.initTxHash.slice(0, 12) : rec.initSkippedReason ?? "unknown"}\n`,
    );
    records.push(rec);
  }
  // Bob is non-contract; no wasm to deploy, just ensure he exists with a
  // keypair. Print as a separate line so the stderr trail is honest
  // about what got created.
  process.stderr.write(`[deploy] bob (${BOB_ACCOUNT_ID})...\n`);
  const bobState = await ensureBob();
  process.stderr.write(`[deploy]   ${bobState}\n`);

  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(join(ARTIFACTS_DIR, "deploys.json"), JSON.stringify(records, null, 2));
  return records;
}

export async function cleanAll(): Promise<void> {
  if (NEAR_NETWORK === "mainnet") {
    process.stderr.write(`[clean] MAINNET: deleting accounts under ${MASTER_ACCOUNT_ID}\n`);
  }
  const near = await connectSender();
  // Reverse order of creation. For flat siblings this is strictly
  // cosmetic (no parent/child dependency) but keeps the balance return
  // in a predictable order in explorer history.
  const order: AccountKey[] = [...DEPLOY_ORDER].reverse();
  for (const key of order) {
    const id = ACCOUNTS[key];
    if (!(await accountExists(id))) {
      process.stderr.write(`[clean] ${id}: absent, skipping\n`);
      if (existsSync(credentialPath(id))) rmSync(credentialPath(id));
      continue;
    }
    process.stderr.write(`[clean] deleting ${id}...\n`);
    try {
      const account = await near.account(id);
      // Remaining balance returns to the master.
      await account.deleteAccount(MASTER_ACCOUNT_ID);
      if (existsSync(credentialPath(id))) rmSync(credentialPath(id));
    } catch (e) {
      process.stderr.write(`[clean]   ${id}: ${(e as Error).message}\n`);
    }
  }
  // Bob last (non-contract participant).
  if (await accountExists(BOB_ACCOUNT_ID)) {
    process.stderr.write(`[clean] deleting ${BOB_ACCOUNT_ID}...\n`);
    try {
      const bob = await near.account(BOB_ACCOUNT_ID);
      await bob.deleteAccount(MASTER_ACCOUNT_ID);
      if (existsSync(credentialPath(BOB_ACCOUNT_ID))) rmSync(credentialPath(BOB_ACCOUNT_ID));
    } catch (e) {
      process.stderr.write(`[clean]   ${BOB_ACCOUNT_ID}: ${(e as Error).message}\n`);
    }
  } else {
    process.stderr.write(`[clean] ${BOB_ACCOUNT_ID}: absent, skipping\n`);
    if (existsSync(credentialPath(BOB_ACCOUNT_ID))) rmSync(credentialPath(BOB_ACCOUNT_ID));
  }
}
