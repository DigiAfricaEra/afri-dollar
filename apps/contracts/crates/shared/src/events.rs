use soroban_sdk::{Address, Env, IntoVal, Symbol, Val, Vec};

/// Publish a standard transfer event.
///
/// # Topic ordering
///
/// Topics are ordered as `[Symbol("transfer"), from, to]`. An optional
/// `asset` address, when provided, is appended as a fourth topic:
/// `[Symbol("transfer"), from, to, asset]`.
///
/// # Data
///
/// The data payload is the transfer `amount` as an `i128`.
///
/// # Examples
///
/// ```rust,ignore
/// publish_transfer(&env, &sender, &recipient, 1_000, None);
/// publish_transfer(&env, &sender, &recipient, 1_000, Some(&token_address));
/// ```
pub fn publish_transfer(
    env: &Env,
    from: &Address,
    to: &Address,
    amount: i128,
    asset: Option<&Address>,
) {
    let mut topics: Vec<Val> = soroban_sdk::vec![
        env,
        Symbol::new(env, "transfer").into_val(env),
        from.into_val(env),
        to.into_val(env),
    ];
    if let Some(a) = asset {
        topics.push_back(a.into_val(env));
    }
    #[allow(deprecated)]
    env.events().publish(topics, amount);
}

/// Publish a standard admin action event.
///
/// # Topic ordering
///
/// Topics are ordered as `[Symbol("admin"), symbol]` where `symbol`
/// identifies the action (e.g. `"pause"`, `"unpause"`, `"upgrade"`).
///
/// # Data
///
/// The `data` payload is an arbitrary Soroban `Val`. Pass `()` for
/// actions that carry no payload.
///
/// # Examples
///
/// ```rust,ignore
/// publish_admin_action(&env, symbol_short!("pause"), ());
/// publish_admin_action(&env, symbol_short!("upgrade"), new_version);
/// ```
pub fn publish_admin_action(env: &Env, symbol: Symbol, data: Val) {
    let topics: Vec<Val> = soroban_sdk::vec![
        env,
        Symbol::new(env, "admin").into_val(env),
        symbol.into_val(env),
    ];
    #[allow(deprecated)]
    env.events().publish(topics, data);
}
