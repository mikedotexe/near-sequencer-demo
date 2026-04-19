import { homedir } from "node:os";
import { join } from "node:path";

import { loadDotEnv } from "./env.js";

// Load `<repo-root>/.env` before any other config reads process.env. Keys
// that are already set in the environment win — shell exports override the
// file, same as every other dotenv loader.
const REPO_ROOT_FOR_ENV = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
loadDotEnv(REPO_ROOT_FOR_ENV);

export const FASTNEAR_API_KEY = process.env.FASTNEAR_API_KEY ?? "";

// Network selection. Must be `testnet` or `mainnet`; anything else is a typo
// we want to catch at startup rather than silently default to testnet.
const rawNetwork = (process.env.NEAR_NETWORK ?? "testnet").toLowerCase();
if (rawNetwork !== "testnet" && rawNetwork !== "mainnet") {
  throw new Error(`NEAR_NETWORK must be "testnet" or "mainnet", got "${rawNetwork}"`);
}
export const NEAR_NETWORK: "testnet" | "mainnet" = rawNetwork;

// Per-network defaults.
const NETWORK_DEFAULTS = {
  testnet: {
    masterAccount: "mike.testnet",
    rpcSend: "https://rpc.testnet.fastnear.com",
    rpcAudit: "https://archival-rpc.testnet.fastnear.com",
    explorerBase: "https://testnet.nearblocks.io",
    expectedChainId: "testnet",
  },
  mainnet: {
    masterAccount: "mike.near",
    rpcSend: "https://rpc.mainnet.fastnear.com",
    rpcAudit: "https://archival-rpc.mainnet.fastnear.com",
    explorerBase: "https://nearblocks.io",
    expectedChainId: "mainnet",
  },
} as const;

const DEFAULTS = NETWORK_DEFAULTS[NEAR_NETWORK];

export const MASTER_ACCOUNT_ID = process.env.MASTER_ACCOUNT_ID ?? DEFAULTS.masterAccount;

// Flat sibling layout: both contracts are direct subaccounts of the master,
// plus one non-contract participant account for Recipe 4 (atomic handoff).
//
//   mike.{net}
//   ├── recipes.mike.{net}           ← NEP-519 recipe book
//   ├── recipes-counter.mike.{net}   ← canonical counter (target for Recipe 3)
//   └── bob.mike.{net}               ← nominated handoff recipient (Recipe 4)
//
// The `recipes-counter` prefix ties the counter to this repo semantically
// and sidesteps a collision on testnet where `counter.mike.testnet` is
// already occupied by an earlier experiment whose key we don't control.
// Bob gets his own keypair (managed by accounts.ts) so he can sign the
// resume tx himself — the whole point of "nominated recipient" is that
// access control is enforced on *who signed resume*.
// Each ACCOUNT_* env var overrides its role independently if needed.
export const ACCOUNTS = {
  recipes: process.env.ACCOUNT_RECIPES ?? `recipes.${MASTER_ACCOUNT_ID}`,
  counter: process.env.ACCOUNT_COUNTER ?? `recipes-counter.${MASTER_ACCOUNT_ID}`,
} as const;

export type AccountKey = keyof typeof ACCOUNTS;

// Bob is a demo participant, not a contract host — no wasm is deployed
// to him. He exists so Recipe 4's handoff can actually move funds to a
// real, watchable on-chain account. The demo flow signs both yield and
// resume from Alice (the handoff's resume is permissionless); Bob's
// keypair is still written at creation so a future variant can have
// him sign directly if desired.
export const BOB_ACCOUNT_ID = process.env.ACCOUNT_BOB ?? `bob.${MASTER_ACCOUNT_ID}`;
// Bob's initial balance is gas-runway for handoff_resume calls. Each resume
// costs ~a few mNEAR; 0.5 NEAR covers hundreds of demo runs.
export const BOB_INITIAL_BALANCE_NEAR = process.env.BOB_INITIAL_BALANCE_NEAR ?? "0.5";

export const WASM_PATHS: Record<AccountKey, string> = {
  recipes: "target/wasm32-unknown-unknown/release/recipes.wasm",
  counter: "target/wasm32-unknown-unknown/release/counter.wasm",
};

// FastNEAR is the current community RPC; rpc.testnet.near.org is deprecated.
// Canonical URLs per https://docs.fastnear.com (visited 2026-04-18):
//   Mainnet:  https://rpc.mainnet.fastnear.com  /  https://archival-rpc.mainnet.fastnear.com
//   Testnet:  https://rpc.testnet.fastnear.com  /  https://archival-rpc.testnet.fastnear.com
// Auth: one API key (via FASTNEAR_API_KEY env) works across all four; sent
// as `Authorization: Bearer <key>`. See scripts/src/rpc.ts.
export const RPC_SEND = process.env.RPC_SEND ?? DEFAULTS.rpcSend;
export const RPC_AUDIT = process.env.RPC_AUDIT ?? DEFAULTS.rpcAudit;

export const EXPLORER_BASE = DEFAULTS.explorerBase;
export const EXPECTED_CHAIN_ID = DEFAULTS.expectedChainId;

export const CREDENTIALS_DIR = process.env.NEAR_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials");
export const NETWORK_CREDENTIALS_DIR = join(CREDENTIALS_DIR, NEAR_NETWORK);

export const REPO_ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
// Artifacts partition by network. Testnet and mainnet are both
// first-class targets (see docs/mainnet-readiness.md); each network
// gets its own artifact subtree — artifacts/testnet/ and
// artifacts/mainnet/ — so their receipt DAGs, audits, and reports
// stay cleanly separable. The cross-network comparison lives in
// artifacts/comparative.md.
export const ARTIFACTS_ROOT = join(REPO_ROOT, "artifacts");
export const ARTIFACTS_DIR = join(ARTIFACTS_ROOT, NEAR_NETWORK);

// Per-contract initial balance. Both wasms are small (~40 KiB and ~191 KiB),
// and each recipe call spends negligible NEAR beyond gas. 3 NEAR covers
// deployment + storage + plenty of runtime headroom.
const INITIAL_BALANCE_BY_NETWORK = { testnet: "3", mainnet: "3" } as const;
export const INITIAL_BALANCE_NEAR =
  process.env.INITIAL_BALANCE_NEAR ?? INITIAL_BALANCE_BY_NETWORK[NEAR_NETWORK];

// Gas budgets
//
// GAS_YIELD_TGAS — outer gas on the `recipe_*_yield(...)` function call.
// The recipes contract internally allocates 150 Tgas via
// `GAS_YIELD_CALLBACK` for the callback reservation; that's prepaid and
// locked separately. The outer tx only needs enough for argument
// deserialization, yield wiring, and trace emission. 200 Tgas is generous.
export const GAS_YIELD_TGAS = 200;
// GAS_RESUME_TGAS — outer gas on `recipe_*_resume(...)`. The callback's
// work runs on its own prepaid budget (locked at yield time). Resume itself
// only emits `recipe_resumed` and delivers the payload to the already-
// scheduled callback receipt. 100 Tgas is plenty; in practice it spends
// ~5 Tgas.
export const GAS_RESUME_TGAS = 100;
export const DEPOSIT_YOCTO_ZERO = "0";

// Recipe 4 — atomic handoff. 0.01 NEAR per handoff: real enough to feel,
// small enough that the signer's balance barely moves across many runs.
// Claim path: Alice → contract → Bob (net -0.01 NEAR for Alice, +0.01 for Bob).
// Timeout path: Alice → contract → Alice (net 0 for Alice; tx gas is the
// only cost).
export const HANDOFF_AMOUNT_YOCTO = process.env.HANDOFF_AMOUNT_YOCTO ?? "10000000000000000000000";

// Poll intervals for waiting on resolution.
export const RUN_POLL_INTERVAL_MS = 1500;
// Basic/chained: resume fires quickly; 60 s is plenty.
export const BASIC_RUN_TIMEOUT_MS = 60_000;
// Timeout recipe: NEP-519's 200-block budget is ~3.5 min on testnet
// (testnet blocks are ~1 s). Budget 5 min to accommodate variance.
export const TIMEOUT_RUN_TIMEOUT_MS = 300_000;
// Handoff timeout-path run: same physical wait as the timeout recipe
// (the same 200-block NEP-519 budget applies to the yielded callback).
export const HANDOFF_TIMEOUT_RUN_TIMEOUT_MS = 300_000;
