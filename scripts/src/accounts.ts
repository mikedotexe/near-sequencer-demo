import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, utils } from "near-api-js";

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

async function ensureAccount(key: AccountKey): Promise<"existed" | "created"> {
  const accountId = ACCOUNTS[key];
  if (await accountExists(accountId)) return "existed";
  const near = await connectSender();
  // Both contracts are direct children of the master; one creator for all.
  const creator = await near.account(MASTER_ACCOUNT_ID);
  const keyPair = KeyPair.fromRandom("ed25519");
  writeCredential(accountId, keyPair);
  const amount = parseNearToYocto(INITIAL_BALANCE_NEAR);
  await creator.createAccount(accountId, keyPair.getPublicKey(), amount);
  return "created";
}

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

async function deployAndMaybeInit(key: AccountKey): Promise<DeployRecord> {
  const accountId = ACCOUNTS[key];
  const wasmPath = join(REPO_ROOT, WASM_PATHS[key]);
  if (!existsSync(wasmPath)) {
    throw new Error(`wasm not found: ${wasmPath} (did you run demo.sh build?)`);
  }
  const sha = wasmSha256(wasmPath);

  const createState = await ensureAccount(key);

  const near = await connectSender();
  const account = await near.account(accountId);

  const wasmBytes = readFileSync(wasmPath);
  const deployResult = await account.deployContract(wasmBytes);
  const deployTxHash = deployResult.transaction?.hash ?? deployResult.transaction_outcome?.id ?? "unknown";

  let initTxHash: string | null = null;
  let initSkippedReason: string | null = null;
  try {
    const initArgs = INIT_ARGS[key];
    const result = await account.functionCall({
      contractId: accountId,
      methodName: "new",
      args: initArgs,
      gas: BigInt(60_000_000_000_000),
      attachedDeposit: 0n,
    });
    initTxHash = result.transaction?.hash ?? null;
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/already\b.*(exists|initialized)|state already exists|ContractCodeDoesntExist/i.test(msg)) {
      initSkippedReason = "already-initialized";
    } else {
      throw e;
    }
  }

  return {
    key,
    accountId,
    created: createState === "created",
    wasmPath,
    wasmSha256: sha,
    wasmSize: wasmBytes.length,
    deployTxHash,
    initTxHash,
    initSkippedReason,
    timestamp: new Date().toISOString(),
  };
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
