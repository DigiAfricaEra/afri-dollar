use soroban_sdk::Env;

/// Number of ledgers in approximately one day.
pub const DAY_IN_LEDGERS: u32 = 17_280;

/// Instance storage TTL bump amount: 7 days.
pub const INSTANCE_BUMP_AMOUNT: u32 = 7 * DAY_IN_LEDGERS;

/// Instance storage lifetime threshold: 6 days.
/// Entries whose remaining TTL falls below this value are bumped.
pub const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - DAY_IN_LEDGERS;

/// Extend the contract instance storage TTL.
///
/// This is the original helper preserved for backwards compatibility.
/// It bumps instance storage when the remaining TTL falls below
/// [`INSTANCE_LIFETIME_THRESHOLD`].
pub fn extend_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}

/// Bump TTL for the contract instance **and** zero or more persistent
/// storage entries in a single call.
///
/// # Arguments
///
/// * `env` — the Soroban environment.
/// * `persistent_keys` — a slice of storage keys whose TTL should be
///   bumped. Each key must exist in persistent storage; missing keys are
///   silently ignored by the Soroban host.
///
/// # Behaviour
///
/// 1. Calls [`extend_instance_ttl`] to bump instance storage.
/// 2. For each key in `persistent_keys`, extends the persistent storage
///    TTL using the same [`INSTANCE_LIFETIME_THRESHOLD`] and
///    [`INSTANCE_BUMP_AMOUNT`] constants.
///
/// # Examples
///
/// ```rust,ignore
/// use soroban_sdk::symbol_short;
///
/// let keys = soroban_sdk::vec![&env, symbol_short!("config"), symbol_short!("admin")];
/// bump_instance_and_persistent(&env, &keys);
/// ```
pub fn bump_instance_and_persistent(
    env: &Env,
    persistent_keys: &soroban_sdk::Vec<soroban_sdk::Val>,
) {
    extend_instance_ttl(env);
    for key in persistent_keys.iter() {
        env.storage().persistent().extend_ttl(
            &key,
            INSTANCE_LIFETIME_THRESHOLD,
            INSTANCE_BUMP_AMOUNT,
        );
    }
}
