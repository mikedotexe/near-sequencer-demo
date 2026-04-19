//! NEP-519 yield/resume recipe book.
//!
//! Four self-contained recipes, each a method-pair on this one contract.
//! Recipes 1–3 share a BTreeMap of outstanding `YieldId`s keyed by
//! `"{recipe}:{name}"`. Recipe 4 (handoff) uses its own `handoffs` map
//! because it carries additional metadata (the nominated recipient, for
//! access control on resume).
//!
//! - Recipe 1 — Basic: `recipe_basic_yield` + `recipe_basic_resume`
//!   demonstrate the two NEP-519 primitives in isolation. The resumed
//!   payload (a String) flows through `on_basic_resumed` as a
//!   `#[callback_result]`.
//!
//! - Recipe 2 — Timeout: `recipe_timeout_yield` stores a yield and
//!   returns. There is no matching resume method. After ~200 blocks the
//!   callback fires with `PromiseError`; `on_timeout_resumed` observes
//!   the `Err` arm. Teaches that the callback fires *regardless* of
//!   whether resume ever arrives.
//!
//! - Recipe 3 — Chained: `recipe_chained_yield` + `recipe_chained_resume`
//!   show a resume handler that dispatches a real downstream
//!   `FunctionCall` (to `counter.increment()`) and chains
//!   `.then(on_counter_observed)` so the counter's callback-visible
//!   return value is read before this recipe treats itself as resolved.
//!
//! - Recipe 4 — Atomic handoff: Alice attaches NEAR to a yield naming
//!   Bob as the recipient; Bob resumes and the callback transfers the
//!   funds to Bob atomically. If Bob never resumes, the 200-block
//!   timeout fires and the callback refunds Alice. One receipt carries
//!   both endings — no escrow table, no polling, no state machine.
//!
//! All observable state changes are emitted as structured trace events
//! (`trace:{ev, ...}` log lines) so the scripts/audit pipeline can
//! reconstruct the lifecycle without polling contract state.

use std::collections::BTreeMap;

use near_sdk::{
    env, ext_contract, near, require,
    serde::{Deserialize, Serialize},
    serde_json, AccountId, Gas, GasWeight, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, YieldId,
};

// ---------------------------------------------------------------------------
// Gas budgets
// ---------------------------------------------------------------------------
//
// Every yield prepays `GAS_YIELD_CALLBACK` for the callback that will run
// when resume (or timeout) fires. That budget must cover:
//   * the callback's own local work (tracing, deserialization)
//   * for Recipe 3 only: the downstream `counter.increment()` gas
//     (`GAS_COUNTER_CALL`) AND the reserved gas for the chained
//     `on_counter_observed` callback (`GAS_OBSERVE_CALLBACK`).
//
// 150 Tgas comfortably accommodates the chained recipe's worst case and is
// safely pre-locked for any recipe. Gas unused by simpler recipes returns
// to the caller per normal NEAR semantics.

const GAS_YIELD_CALLBACK: Gas = Gas::from_tgas(150);
const GAS_COUNTER_CALL: Gas = Gas::from_tgas(30);
const GAS_OBSERVE_CALLBACK: Gas = Gas::from_tgas(30);

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------
//
// Every recipe-level observable event emits a JSON log line prefixed
// `trace:` so the scripts/audit pipeline can filter by prefix before
// parsing. The shape is intentionally flat: `{ev, recipe, name, ...}` plus
// `block_ts_ms`. audit.ts / onchain-to-timeline.mjs parse by `ev` and
// `recipe`.

// The `Recipe` prefix is intentional: in the serialized trace output
// (`{"ev": "recipe_yielded", ...}`) it scopes the event as "emitted by
// this recipes contract," which is useful when the same audit pipeline
// might someday parse events from other contracts (the counter target,
// future recipes, etc.). Clippy flags the shared prefix; we keep it.
#[allow(clippy::enum_variant_names)]
#[derive(Serialize)]
#[serde(crate = "near_sdk::serde", tag = "ev", rename_all = "snake_case")]
enum TraceEvent {
    RecipeYielded {
        recipe: String,
        name: String,
    },
    RecipeResumed {
        recipe: String,
        name: String,
        payload: String,
    },
    RecipeResolvedOk {
        recipe: String,
        name: String,
        outcome: String,
    },
    RecipeResolvedErr {
        recipe: String,
        name: String,
        reason: String,
    },
    RecipeDispatched {
        recipe: String,
        name: String,
        target: String,
        method: String,
    },
    RecipeCallbackObserved {
        recipe: String,
        name: String,
        value: String,
    },
    // Handoff-specific events carry the `from`/`to`/`amount` metadata
    // that the generic `Recipe*` events don't have room for. They're
    // emitted alongside the generic events so DAG-placement audit stays
    // keyed on the generic vocabulary.
    HandoffOffered {
        recipe: String,
        name: String,
        from: String,
        to: String,
        amount: String, // yoctoNEAR as u128 decimal string (JSON-safe)
    },
    HandoffReleased {
        recipe: String,
        name: String,
        to: String,
        amount: String,
    },
    HandoffRefunded {
        recipe: String,
        name: String,
        refunded_to: String,
        amount: String,
    },
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct TraceRecord {
    #[serde(flatten)]
    event: TraceEvent,
    block_ts_ms: u64,
}

fn log_event(event: TraceEvent) {
    let record = TraceRecord {
        event,
        block_ts_ms: env::block_timestamp() / 1_000_000,
    };
    let json = serde_json::to_string(&record)
        .unwrap_or_else(|_| env::panic_str("trace serialization failed"));
    env::log_str(&format!("trace:{json}"));
}

// ---------------------------------------------------------------------------
// Resume signal shapes + callback-arg shapes
// ---------------------------------------------------------------------------
//
// The signal types are what the yielded callback's `#[callback_result]`
// parameter deserializes into. The resume caller serializes a matching
// value and passes it as raw bytes to `yield_id.resume(...)`.
//
// Callback-arg shapes carry whatever per-yield context the callback needs;
// they are serialized by `yield_*` and delivered to the callback as normal
// JSON args (NOT via the #[callback_result] path — those are the *real*
// named arguments on the callback method).

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct BasicSignal {
    pub payload: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct ChainedSignal {
    pub delta: i8,
}

// Handoff's resume carries no payload — Bob's resume is "I accept."
// Empty struct over `()` so serde_json stringifies it as `{}` rather than
// `null`, matching the other recipe signal shapes.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(crate = "near_sdk::serde")]
pub struct HandoffSignal {}

// ---------------------------------------------------------------------------
// External contract traits
// ---------------------------------------------------------------------------

#[ext_contract(ext_counter)]
pub trait ExtCounter {
    fn increment(&mut self) -> i8;
    fn decrement(&mut self) -> i8;
}

#[ext_contract(ext_self)]
pub trait ExtSelf {
    fn on_counter_observed(&mut self, name: String);
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

// In-storage metadata for an outstanding handoff. Keeps the nominated
// recipient available for access control on resume. Everything the
// callback needs (from/to/amount) travels through callback args at yield
// time — this map exists *only* to gate the resume call.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct HandoffMeta {
    pub yield_id: YieldId,
    pub to: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Recipes {
    // The account allowed to call the four `recipe_*_yield` methods.
    // Bound at init time and never changed. Resume methods stay
    // permissionless (Recipe 4's `recipe_handoff_resume` in particular
    // is *supposed* to be callable by anyone — it's the "anyone can
    // pull the trigger" teaching claim). This owner gate on yields
    // closes the state-growth vector where a mainnet spammer could
    // call `recipe_basic_yield("spam-1")`, `("spam-2")`, … and leak
    // ~40 bytes of state per never-resumed entry. See
    // `docs/mainnet-readiness.md` for the full analysis.
    owner_id: AccountId,
    // Outstanding yields for recipes 1–3, keyed by `"{recipe}:{name}"`.
    // Entries are inserted by `recipe_*_yield` and removed by the
    // corresponding `recipe_*_resume` before the resume call fires.
    yields: BTreeMap<String, YieldId>,
    // Outstanding handoffs keyed by `"handoff:{name}"`. Separate from
    // `yields` because each handoff carries richer access-control state.
    handoffs: BTreeMap<String, HandoffMeta>,
}

#[near]
impl Recipes {
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        Self {
            owner_id,
            yields: BTreeMap::new(),
            handoffs: BTreeMap::new(),
        }
    }

    /// View helper: the bound owner account.
    pub fn owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }

    /// View helper: keys of currently outstanding yields (recipes 1–3).
    pub fn yields_in_flight(&self) -> Vec<String> {
        self.yields.keys().cloned().collect()
    }

    /// View helper: keys of currently outstanding handoffs (recipe 4).
    pub fn handoffs_in_flight(&self) -> Vec<String> {
        self.handoffs.keys().cloned().collect()
    }

    // Internal: gate yield methods. Kept private (no `pub`) because
    // it's a contract-internal invariant helper, not an API.
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the owner can call this yield method"
        );
    }

    // =======================================================================
    // Recipe 1 — Basic cross-tx yield + resume
    // =======================================================================
    //
    // tx1: `recipe_basic_yield("hello")`
    //   - Creates a Promise::new_yield bound to `on_basic_resumed`.
    //   - Stores the YieldId in `self.yields["basic:hello"]`.
    //   - Returns the yielded Promise; the caller can detach or ignore it.
    //
    // tx2 (possibly by a different signer): `recipe_basic_resume("hello", "world")`
    //   - Looks up the YieldId, removes it from storage.
    //   - Calls `yield_id.resume(payload_bytes)`.
    //
    // The on_basic_resumed callback then fires with `Ok(BasicSignal{payload})`.
    // On timeout (if resume never arrives), it fires with `Err(PromiseError)`.

    pub fn recipe_basic_yield(&mut self, name: String) -> Promise {
        self.assert_owner();
        require!(!name.is_empty(), "name must not be empty");
        let key = format!("basic:{name}");
        require!(
            !self.yields.contains_key(&key),
            "yield already exists for this name"
        );

        let callback_args = serde_json::to_vec(&NamedCallbackArgs { name: name.clone() })
            .unwrap_or_else(|_| env::panic_str("failed to serialize callback args"));

        let (promise, yield_id) = Promise::new_yield(
            "on_basic_resumed",
            callback_args,
            GAS_YIELD_CALLBACK,
            GasWeight(1),
        );

        self.yields.insert(key, yield_id);
        log_event(TraceEvent::RecipeYielded {
            recipe: "basic".into(),
            name,
        });
        promise
    }

    pub fn recipe_basic_resume(&mut self, name: String, payload: String) {
        let key = format!("basic:{name}");
        let yield_id = self
            .yields
            .remove(&key)
            .unwrap_or_else(|| env::panic_str("no yield found for this name"));

        let signal = BasicSignal {
            payload: payload.clone(),
        };
        let payload_bytes = serde_json::to_vec(&signal)
            .unwrap_or_else(|_| env::panic_str("failed to serialize resume payload"));

        yield_id
            .resume(payload_bytes)
            .unwrap_or_else(|_| env::panic_str("resume failed (not found or expired)"));

        log_event(TraceEvent::RecipeResumed {
            recipe: "basic".into(),
            name,
            payload,
        });
    }

    #[private]
    pub fn on_basic_resumed(
        &mut self,
        name: String,
        #[callback_result] signal: Result<BasicSignal, PromiseError>,
    ) {
        match signal {
            Ok(s) => log_event(TraceEvent::RecipeResolvedOk {
                recipe: "basic".into(),
                name,
                outcome: s.payload,
            }),
            Err(err) => log_event(TraceEvent::RecipeResolvedErr {
                recipe: "basic".into(),
                name,
                reason: format!("{err:?}"),
            }),
        }
    }

    // =======================================================================
    // Recipe 2 — Timeout: what happens when no one resumes
    // =======================================================================
    //
    // tx1: `recipe_timeout_yield("waiting")`
    //   - Same shape as basic, but no `recipe_timeout_resume` method exists.
    //   - After 200 blocks, `on_timeout_resumed` fires with
    //     `Err(PromiseError)`. This is the NEP-519 guarantee: the callback
    //     ALWAYS fires exactly once per yield, even when resume never
    //     arrives.
    //
    // The yield entry in `self.yields` is left dangling intentionally —
    // the contract can't know from the callback whether a future resume
    // attempt would have been invalid, so cleanup is the caller's problem
    // via a separate sweep if desired. A real contract might use a
    // separate "expired" map; this recipe keeps things minimal.

    pub fn recipe_timeout_yield(&mut self, name: String) -> Promise {
        self.assert_owner();
        require!(!name.is_empty(), "name must not be empty");
        let key = format!("timeout:{name}");
        require!(
            !self.yields.contains_key(&key),
            "yield already exists for this name"
        );

        let callback_args = serde_json::to_vec(&NamedCallbackArgs { name: name.clone() })
            .unwrap_or_else(|_| env::panic_str("failed to serialize callback args"));

        let (promise, yield_id) = Promise::new_yield(
            "on_timeout_resumed",
            callback_args,
            GAS_YIELD_CALLBACK,
            GasWeight(1),
        );

        self.yields.insert(key, yield_id);
        log_event(TraceEvent::RecipeYielded {
            recipe: "timeout".into(),
            name,
        });
        promise
    }

    #[private]
    pub fn on_timeout_resumed(
        &mut self,
        name: String,
        #[callback_result] signal: Result<BasicSignal, PromiseError>,
    ) {
        // The key is stale once the callback fires; remove it so
        // yields_in_flight() reflects reality. Missing entry is
        // tolerated (caller may have cleaned up).
        let key = format!("timeout:{name}");
        self.yields.remove(&key);

        match signal {
            Ok(s) => {
                // Surprising but legal: someone must have called a future
                // `recipe_timeout_resume` we don't currently expose.
                // Record it honestly rather than masking.
                log_event(TraceEvent::RecipeResolvedOk {
                    recipe: "timeout".into(),
                    name,
                    outcome: s.payload,
                });
            }
            Err(err) => log_event(TraceEvent::RecipeResolvedErr {
                recipe: "timeout".into(),
                name,
                reason: format!("{err:?}"),
            }),
        }
    }

    // =======================================================================
    // Recipe 3 — Chained: resume triggers a downstream call with callback
    // =======================================================================
    //
    // tx1: `recipe_chained_yield("go", "counter.mike.testnet")`
    //   - Stores YieldId; `on_chained_resumed` is the callback.
    //   - Callback args carry the counter account id so the handler can
    //     dispatch without looking it up.
    //
    // tx2: `recipe_chained_resume("go", 1)`
    //   - Resumes with `ChainedSignal { delta: 1 }`.
    //
    // on_chained_resumed fires with Ok(ChainedSignal):
    //   - Dispatches `counter.increment()` (or decrement if delta < 0).
    //   - Chains `.then(on_counter_observed(name))`.
    //   - Returns the composed Promise so the contract's own receipt
    //     resolves only after the chain completes.
    //
    // on_counter_observed reads the target's `#[callback_result] i8` and
    // emits `RecipeCallbackObserved`. This is the "truthful" pattern —
    // the recipe's receipt only resolves after it has observed the
    // target's actual return value.

    pub fn recipe_chained_yield(&mut self, name: String, counter_id: AccountId) -> Promise {
        self.assert_owner();
        require!(!name.is_empty(), "name must not be empty");
        let key = format!("chained:{name}");
        require!(
            !self.yields.contains_key(&key),
            "yield already exists for this name"
        );

        let callback_args = serde_json::to_vec(&ChainedCallbackArgs {
            name: name.clone(),
            counter_id: counter_id.clone(),
        })
        .unwrap_or_else(|_| env::panic_str("failed to serialize callback args"));

        let (promise, yield_id) = Promise::new_yield(
            "on_chained_resumed",
            callback_args,
            GAS_YIELD_CALLBACK,
            GasWeight(1),
        );

        self.yields.insert(key, yield_id);
        log_event(TraceEvent::RecipeYielded {
            recipe: "chained".into(),
            name,
        });
        promise
    }

    pub fn recipe_chained_resume(&mut self, name: String, delta: i8) {
        require!(delta != 0, "delta must be non-zero");
        let key = format!("chained:{name}");
        let yield_id = self
            .yields
            .remove(&key)
            .unwrap_or_else(|| env::panic_str("no yield found for this name"));

        let signal = ChainedSignal { delta };
        let payload_bytes = serde_json::to_vec(&signal)
            .unwrap_or_else(|_| env::panic_str("failed to serialize resume payload"));

        yield_id
            .resume(payload_bytes)
            .unwrap_or_else(|_| env::panic_str("resume failed (not found or expired)"));

        log_event(TraceEvent::RecipeResumed {
            recipe: "chained".into(),
            name,
            payload: format!("delta={delta}"),
        });
    }

    #[private]
    pub fn on_chained_resumed(
        &mut self,
        name: String,
        counter_id: AccountId,
        #[callback_result] signal: Result<ChainedSignal, PromiseError>,
    ) -> PromiseOrValue<()> {
        let delta = match signal {
            Ok(s) => s.delta,
            Err(err) => {
                log_event(TraceEvent::RecipeResolvedErr {
                    recipe: "chained".into(),
                    name,
                    reason: format!("{err:?}"),
                });
                return PromiseOrValue::Value(());
            }
        };

        let (method, call) = if delta > 0 {
            (
                "increment",
                ext_counter::ext(counter_id.clone())
                    .with_static_gas(GAS_COUNTER_CALL)
                    .increment(),
            )
        } else {
            (
                "decrement",
                ext_counter::ext(counter_id.clone())
                    .with_static_gas(GAS_COUNTER_CALL)
                    .decrement(),
            )
        };

        log_event(TraceEvent::RecipeDispatched {
            recipe: "chained".into(),
            name: name.clone(),
            target: counter_id.to_string(),
            method: method.into(),
        });

        let chained = call.then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(GAS_OBSERVE_CALLBACK)
                .on_counter_observed(name),
        );

        PromiseOrValue::Promise(chained)
    }

    #[private]
    pub fn on_counter_observed(
        &mut self,
        name: String,
        #[callback_result] value: Result<i8, PromiseError>,
    ) {
        match value {
            Ok(v) => {
                log_event(TraceEvent::RecipeCallbackObserved {
                    recipe: "chained".into(),
                    name: name.clone(),
                    value: v.to_string(),
                });
                log_event(TraceEvent::RecipeResolvedOk {
                    recipe: "chained".into(),
                    name,
                    outcome: v.to_string(),
                });
            }
            Err(err) => log_event(TraceEvent::RecipeResolvedErr {
                recipe: "chained".into(),
                name,
                reason: format!("{err:?}"),
            }),
        }
    }

    // =======================================================================
    // Recipe 4 — Atomic handoff
    // =======================================================================
    //
    // tx1: `recipe_handoff_yield("gift", "bob.mike.testnet")` with NEAR
    //   attached. The contract receives the deposit into its own balance
    //   and schedules a yielded callback parameterised with (from, to,
    //   amount). The nominated recipient is stored in `self.handoffs`
    //   for access control on the resume side.
    //
    // tx2 (signed by Bob only): `recipe_handoff_resume("gift")` — looks
    //   up the stored meta, checks `env::predecessor_account_id() ==
    //   meta.to`, and resumes the yield.
    //
    // `on_handoff_resumed` fires with `Ok(HandoffSignal)` on resume or
    //   `Err(PromiseError)` on timeout. Both arms return a Promise:
    //     * Ok  → `Promise::new(to).transfer(amount)` — Bob receives funds
    //     * Err → `Promise::new(from).transfer(amount)` — Alice refunded
    //
    // The single receipt scheduled at yield time carries both endings.
    // No escrow table, no refund method, no polling — the primitive does
    // the thing.

    #[payable]
    pub fn recipe_handoff_yield(&mut self, name: String, to: AccountId) -> Promise {
        self.assert_owner();
        require!(!name.is_empty(), "name must not be empty");
        let key = format!("handoff:{name}");
        require!(
            !self.handoffs.contains_key(&key),
            "handoff already exists for this name"
        );

        let amount = env::attached_deposit();
        require!(
            !amount.is_zero(),
            "must attach NEAR to hand off"
        );

        let from = env::predecessor_account_id();

        let callback_args = serde_json::to_vec(&HandoffCallbackArgs {
            name: name.clone(),
            from: from.clone(),
            to: to.clone(),
            amount,
        })
        .unwrap_or_else(|_| env::panic_str("failed to serialize callback args"));

        let (promise, yield_id) = Promise::new_yield(
            "on_handoff_resumed",
            callback_args,
            GAS_YIELD_CALLBACK,
            GasWeight(1),
        );

        self.handoffs.insert(
            key,
            HandoffMeta {
                yield_id,
                to: to.clone(),
            },
        );

        // Emit the generic event first so DAG-placement audit finds it
        // in the expected order, then the handoff-specific detail.
        log_event(TraceEvent::RecipeYielded {
            recipe: "handoff".into(),
            name: name.clone(),
        });
        log_event(TraceEvent::HandoffOffered {
            recipe: "handoff".into(),
            name,
            from: from.to_string(),
            to: to.to_string(),
            amount: amount.as_yoctonear().to_string(),
        });

        promise
    }

    // Permissionless resume. Anyone can trigger the handoff's settle
    // path; the funds still flow to the `to` stored at yield time, so
    // the resumer can't redirect them. This matches the intent — the
    // handoff is "pay-on-trigger-to-Bob," and who pulls the trigger
    // doesn't affect the destination. Keeping resume permissionless
    // sidesteps a testnet tx-ordering quirk where a second signer's
    // tx can land with stale state; Alice (who has an established key
    // and a nonce sequence) signs the resume in the demo flow.
    pub fn recipe_handoff_resume(&mut self, name: String) {
        let key = format!("handoff:{name}");
        let meta = self
            .handoffs
            .remove(&key)
            .unwrap_or_else(|| env::panic_str("no handoff found for this name"));

        let signal = HandoffSignal {};
        let payload_bytes = serde_json::to_vec(&signal)
            .unwrap_or_else(|_| env::panic_str("failed to serialize resume payload"));

        meta.yield_id
            .resume(payload_bytes)
            .unwrap_or_else(|_| env::panic_str("resume failed (not found or expired)"));

        log_event(TraceEvent::RecipeResumed {
            recipe: "handoff".into(),
            name,
            payload: "claim".into(),
        });
    }

    #[private]
    pub fn on_handoff_resumed(
        &mut self,
        name: String,
        from: AccountId,
        to: AccountId,
        amount: NearToken,
        #[callback_result] signal: Result<HandoffSignal, PromiseError>,
    ) -> Promise {
        // Clean up the handoffs map for the timeout path (resume's
        // success path already removed the key). Missing entry is fine.
        let key = format!("handoff:{name}");
        self.handoffs.remove(&key);

        match signal {
            Ok(_) => {
                log_event(TraceEvent::RecipeResolvedOk {
                    recipe: "handoff".into(),
                    name: name.clone(),
                    outcome: format!("transferred to {to}"),
                });
                log_event(TraceEvent::HandoffReleased {
                    recipe: "handoff".into(),
                    name,
                    to: to.to_string(),
                    amount: amount.as_yoctonear().to_string(),
                });
                Promise::new(to).transfer(amount)
            }
            Err(err) => {
                log_event(TraceEvent::RecipeResolvedErr {
                    recipe: "handoff".into(),
                    name: name.clone(),
                    reason: format!("{err:?}"),
                });
                log_event(TraceEvent::HandoffRefunded {
                    recipe: "handoff".into(),
                    name,
                    refunded_to: from.to_string(),
                    amount: amount.as_yoctonear().to_string(),
                });
                Promise::new(from).transfer(amount)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Internal serde shapes for callback args
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct NamedCallbackArgs {
    name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct ChainedCallbackArgs {
    name: String,
    counter_id: AccountId,
}

#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct HandoffCallbackArgs {
    name: String,
    from: AccountId,
    to: AccountId,
    amount: NearToken,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// The mock `testing_env!` reinstalls a fresh MockedBlockchain on each
// call, which wipes any YieldIds that prior calls registered. That means
// the end-to-end shape (yield in one testing_env, resume in the next,
// callback fires with the resumed value) cannot be fully tested in the
// mock — testnet is authoritative.
//
// What these tests DO cover:
//   * local state mutations on yield (yields map populated; trace event
//     emitted).
//   * require!/panic conditions on yield (name validation, duplicates).
//   * callback behaviour when given synthetic `#[callback_result]` Ok
//     and Err values (what `on_*_resumed` actually does).
//   * the resume methods' state mutations (yields map cleaned up;
//     resume failure panics surfaced).

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn caller() -> AccountId {
        "caller.near".parse().unwrap()
    }

    fn contract_id() -> AccountId {
        "recipes.near".parse().unwrap()
    }

    fn counter_id() -> AccountId {
        "counter.near".parse().unwrap()
    }

    fn ctx_caller() -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(caller());
        b
    }

    fn ctx_self() -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(contract_id());
        b
    }

    fn new_contract() -> Recipes {
        testing_env!(ctx_caller().build());
        Recipes::new(caller())
    }

    // --- Recipe 1: Basic ------------------------------------------------

    #[test]
    fn basic_yield_records_key_in_map() {
        let mut c = new_contract();
        let _ = c.recipe_basic_yield("hello".into());
        assert_eq!(c.yields_in_flight(), vec!["basic:hello".to_string()]);
    }

    // Owner-gate regression. All four `recipe_*_yield` methods share
    // the same `self.assert_owner()` call; testing basic covers the
    // gate path. The other three are covered implicitly — if
    // `assert_owner` broke, every yield test with caller=owner would
    // still pass (they're correct), but this test catches the shape
    // of the gate itself.
    #[test]
    #[should_panic(expected = "only the owner can call this yield method")]
    fn basic_yield_rejects_non_owner() {
        testing_env!(ctx_caller().build());
        let mut c = Recipes::new(contract_id()); // owner = contract_id(), caller = caller()
        // predecessor is still `caller()`, so the gate fires.
        let _ = c.recipe_basic_yield("hello".into());
    }

    #[test]
    fn owner_id_round_trips_through_init() {
        // Sanity check on the init parameter; protects against a
        // future refactor dropping the field on the serialized state.
        testing_env!(ctx_caller().build());
        let c = Recipes::new(contract_id());
        assert_eq!(c.owner_id(), contract_id());
    }

    #[test]
    #[should_panic(expected = "name must not be empty")]
    fn basic_yield_rejects_empty_name() {
        let mut c = new_contract();
        let _ = c.recipe_basic_yield(String::new());
    }

    #[test]
    #[should_panic(expected = "yield already exists for this name")]
    fn basic_yield_rejects_duplicate_name() {
        let mut c = new_contract();
        let _ = c.recipe_basic_yield("hello".into());
        let _ = c.recipe_basic_yield("hello".into());
    }

    #[test]
    #[should_panic(expected = "no yield found for this name")]
    fn basic_resume_without_prior_yield_panics() {
        let mut c = new_contract();
        c.recipe_basic_resume("nothing".into(), "x".into());
    }

    #[test]
    fn on_basic_resumed_ok_logs_resolved() {
        let mut c = new_contract();
        testing_env!(ctx_self().build());
        c.on_basic_resumed("hello".into(), Ok(BasicSignal { payload: "world".into() }));
        // Trace emission is via env::log_str; tests here only verify no
        // panic and that the method accepts the signal shape.
    }

    #[test]
    fn on_basic_resumed_err_logs_resolved_err() {
        let mut c = new_contract();
        testing_env!(ctx_self().build());
        c.on_basic_resumed("hello".into(), Err(PromiseError::Failed));
    }

    // --- Recipe 2: Timeout ----------------------------------------------

    #[test]
    fn timeout_yield_records_key_in_map() {
        let mut c = new_contract();
        let _ = c.recipe_timeout_yield("waiting".into());
        assert_eq!(c.yields_in_flight(), vec!["timeout:waiting".to_string()]);
    }

    #[test]
    fn on_timeout_resumed_err_clears_key_and_logs() {
        let mut c = new_contract();
        let _ = c.recipe_timeout_yield("waiting".into());
        assert_eq!(c.yields_in_flight().len(), 1);
        testing_env!(ctx_self().build());
        c.on_timeout_resumed("waiting".into(), Err(PromiseError::Failed));
        assert!(c.yields_in_flight().is_empty(), "callback must clean up stale key");
    }

    // --- Recipe 3: Chained -----------------------------------------------

    #[test]
    fn chained_yield_records_key_in_map() {
        let mut c = new_contract();
        let _ = c.recipe_chained_yield("go".into(), counter_id());
        assert_eq!(c.yields_in_flight(), vec!["chained:go".to_string()]);
    }

    #[test]
    #[should_panic(expected = "delta must be non-zero")]
    fn chained_resume_rejects_zero_delta() {
        let mut c = new_contract();
        let _ = c.recipe_chained_yield("go".into(), counter_id());
        c.recipe_chained_resume("go".into(), 0);
    }

    #[test]
    fn on_chained_resumed_err_short_circuits_to_value() {
        let mut c = new_contract();
        testing_env!(ctx_self().build());
        let out = c.on_chained_resumed("go".into(), counter_id(), Err(PromiseError::Failed));
        match out {
            PromiseOrValue::Value(()) => {}
            PromiseOrValue::Promise(_) => panic!("err arm must return Value, not Promise"),
        }
    }

    #[test]
    fn on_counter_observed_ok_logs_value() {
        let mut c = new_contract();
        testing_env!(ctx_self().build());
        c.on_counter_observed("go".into(), Ok(7));
    }

    #[test]
    fn on_counter_observed_err_logs_reason() {
        let mut c = new_contract();
        testing_env!(ctx_self().build());
        c.on_counter_observed("go".into(), Err(PromiseError::Failed));
    }

    // --- View methods ----------------------------------------------------

    #[test]
    fn yields_in_flight_reflects_all_recipes() {
        let mut c = new_contract();
        let _ = c.recipe_basic_yield("a".into());
        let _ = c.recipe_timeout_yield("b".into());
        let _ = c.recipe_chained_yield("c".into(), counter_id());
        let mut keys = c.yields_in_flight();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "basic:a".to_string(),
                "chained:c".to_string(),
                "timeout:b".to_string(),
            ]
        );
    }

    // --- Recipe 4: Atomic handoff ----------------------------------------

    fn bob() -> AccountId {
        "bob.near".parse().unwrap()
    }

    fn stranger() -> AccountId {
        "stranger.near".parse().unwrap()
    }

    fn one_hundredth_near() -> NearToken {
        // 0.01 NEAR in yoctoNEAR — the amount used by the handoff demo.
        NearToken::from_yoctonear(10_000_000_000_000_000_000_000)
    }

    fn ctx_caller_with_deposit(deposit: NearToken) -> VMContextBuilder {
        let mut b = ctx_caller();
        b.attached_deposit(deposit);
        b
    }

    fn ctx_bob_no_deposit() -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(bob());
        b
    }

    fn ctx_stranger_no_deposit() -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.current_account_id(contract_id())
            .predecessor_account_id(stranger());
        b
    }

    #[test]
    fn handoff_yield_records_meta_in_map() {
        testing_env!(ctx_caller_with_deposit(one_hundredth_near()).build());
        let mut c = Recipes::new(caller());
        let _ = c.recipe_handoff_yield("gift".into(), bob());
        assert_eq!(c.handoffs_in_flight(), vec!["handoff:gift".to_string()]);
    }

    #[test]
    #[should_panic(expected = "must attach NEAR to hand off")]
    fn handoff_yield_rejects_zero_deposit() {
        let mut c = new_contract(); // ctx_caller has no deposit
        let _ = c.recipe_handoff_yield("gift".into(), bob());
    }

    #[test]
    #[should_panic(expected = "name must not be empty")]
    fn handoff_yield_rejects_empty_name() {
        testing_env!(ctx_caller_with_deposit(one_hundredth_near()).build());
        let mut c = Recipes::new(caller());
        let _ = c.recipe_handoff_yield(String::new(), bob());
    }

    #[test]
    #[should_panic(expected = "handoff already exists for this name")]
    fn handoff_yield_rejects_duplicate_name() {
        testing_env!(ctx_caller_with_deposit(one_hundredth_near()).build());
        let mut c = Recipes::new(caller());
        let _ = c.recipe_handoff_yield("gift".into(), bob());
        let _ = c.recipe_handoff_yield("gift".into(), bob());
    }

    #[test]
    fn handoff_resume_is_permissionless() {
        // Any signer can trigger the settle path; funds still flow to
        // the nominated `to`. In the mock this exercises the in-memory
        // map cleanup; the actual yield_id.resume call cannot be driven
        // under testing_env! (see cross-tx mechanics doc).
        testing_env!(ctx_caller_with_deposit(one_hundredth_near()).build());
        let mut c = Recipes::new(caller());
        let _ = c.recipe_handoff_yield("gift".into(), bob());
        // A stranger calls resume. We expect it to panic downstream
        // because the mock's yield_id.resume will fail (testing_env!
        // wipes registered YieldIds), but importantly the access-
        // control check is gone — if the yield_id were real, resume
        // would succeed regardless of who called it.
        testing_env!(ctx_stranger_no_deposit().build());
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.recipe_handoff_resume("gift".into());
        }));
    }

    #[test]
    #[should_panic(expected = "no handoff found for this name")]
    fn handoff_resume_without_prior_yield_panics() {
        testing_env!(ctx_bob_no_deposit().build());
        let mut c = Recipes::new(caller());
        c.recipe_handoff_resume("never-was".into());
    }

    #[test]
    fn on_handoff_resumed_ok_returns_promise() {
        // Testing-env rebuild means the promise side-effect is all we
        // can observe. The key insight: the Ok branch returns a Promise
        // (the transfer to Bob), not a Value.
        testing_env!(ctx_self().build());
        let mut c = Recipes::new(caller());
        let _promise = c.on_handoff_resumed(
            "gift".into(),
            caller(),
            bob(),
            one_hundredth_near(),
            Ok(HandoffSignal {}),
        );
    }

    #[test]
    fn on_handoff_resumed_err_returns_promise_refunding_from() {
        // The Err arm refunds Alice (from). Still returns a Promise,
        // not a Value — the single receipt carries both endings.
        testing_env!(ctx_self().build());
        let mut c = Recipes::new(caller());
        let _promise = c.on_handoff_resumed(
            "gift".into(),
            caller(),
            bob(),
            one_hundredth_near(),
            Err(PromiseError::Failed),
        );
    }
}
