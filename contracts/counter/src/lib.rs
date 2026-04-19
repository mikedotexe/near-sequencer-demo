//! Canonical NEAR "hello world" counter.
//!
//! The shape matches `near/near-sdk-rs/examples/status-message` and
//! `near/core-contracts/counter` in spirit: one `i8` field, in-place
//! mutators, a view method. It exists here only as the downstream target
//! for the chained recipe (`recipes::recipe_chained_yield` dispatches to
//! `counter.increment()` on resume and chains a callback to read the
//! post-increment value).

use near_sdk::{env, near, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Counter {
    val: i8,
}

#[near]
impl Counter {
    #[init]
    pub fn new() -> Self {
        Self { val: 0 }
    }

    pub fn get_num(&self) -> i8 {
        self.val
    }

    pub fn increment(&mut self) -> i8 {
        self.val = self.val.saturating_add(1);
        env::log_str(&format!("counter:increment:{}", self.val));
        self.val
    }

    pub fn decrement(&mut self) -> i8 {
        self.val = self.val.saturating_sub(1);
        env::log_str(&format!("counter:decrement:{}", self.val));
        self.val
    }

    pub fn reset(&mut self) {
        self.val = 0;
        env::log_str("counter:reset");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn increment_then_get() {
        let mut c = Counter::new();
        assert_eq!(c.get_num(), 0);
        assert_eq!(c.increment(), 1);
        assert_eq!(c.increment(), 2);
        assert_eq!(c.get_num(), 2);
    }

    #[test]
    fn decrement_goes_negative() {
        let mut c = Counter::new();
        assert_eq!(c.decrement(), -1);
        assert_eq!(c.get_num(), -1);
    }

    #[test]
    fn reset_zeroes_value() {
        let mut c = Counter::new();
        c.increment();
        c.increment();
        c.reset();
        assert_eq!(c.get_num(), 0);
    }

}
