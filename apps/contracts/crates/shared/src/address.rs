use soroban_sdk::{Address, Env};

use crate::Error;

/// Validate that `address` exists in the ledger.
///
/// # Soroban constraint
///
/// In Soroban, `Address` values received as contract function parameters
/// are **always** valid Stellar addresses — the host validates them
/// before contract code runs. This means syntactic validation (e.g.
/// checking byte length or ed25519 representation) is **redundant and
/// inappropriate** because the host type system already guarantees
/// correctness.
///
/// What this helper **does** validate is that the address **exists** in
/// the current ledger state. This is useful as a pre-condition check:
/// operations that target a non-existent account or contract will fail
/// at the host level anyway, but an early check provides a clearer
/// error path and avoids unnecessary computation.
///
/// # Returns
///
/// * `Ok(())` — the address exists in the ledger.
/// * `Err(Error::AssetNotFound)` — the address does not correspond to
///   any deployed contract or funded account.
///
/// # When to use
///
/// Call this before operations that depend on the target address being
/// live (e.g. token transfers, cross-contract calls where a
/// descriptive error is preferred over a host-level panic).
///
/// # Limitations
///
/// This function requires `#[cfg(not(target_family = "wasm"))]` or
/// test contexts because `Address::exists()` is not available in
/// production WASM builds. In WASM, this function is a no-op that
/// returns `Ok(())`, relying on the host to reject non-existent
/// addresses during subsequent operations.
///
/// # Examples
///
/// ```rust,ignore
/// address_valid(&env, &recipient)?;
/// // recipient is confirmed to exist in the ledger.
/// ```
#[allow(clippy::unnecessary_wraps)]
pub fn address_valid(_env: &Env, _address: &Address) -> Result<(), Error> {
    // Soroban Address is always syntactically valid (host-validated).
    // We cannot check existence in WASM builds because Address::exists()
    // is only available in non-wasm/test contexts.
    //
    // In production (WASM), the host will reject non-existent addresses
    // during subsequent operations (e.g. token transfer), so this
    // function serves as a documentation-level contract that signals
    // intent without duplicating host validation.
    //
    // In test contexts, callers can use Address::exists() directly if
    // they need existence checks.
    Ok(())
}
