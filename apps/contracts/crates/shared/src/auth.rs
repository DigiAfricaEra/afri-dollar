use soroban_sdk::{Address, Env};

use crate::Error;

/// Require authorization from `caller`, skipping the authentication check
/// when `caller` matches an admin address.
///
/// # Behaviour
///
/// 1. If `admin` is `Some` and `*caller == admin`, the function returns
///    `Ok(())` immediately — **no** `require_auth()` is called. This
///    prevents double-authentication when the admin is the caller.
/// 2. If `admin` is `None` or `caller != admin`, `caller.require_auth()`
///    is called and the result determines success or failure.
///
/// # Returns
///
/// * `Ok(())` — the caller is authorized (either as admin or via auth).
/// * `Err(Error::Unauthorized)` — the Soroban host rejected the
///   authorization request.
///
/// # Examples
///
/// ```rust,ignore
/// // Admin bypasses auth
/// require_auth_or_admin(&env, &admin_address, Some(&admin_address))?;
/// // Non-admin must authenticate
/// require_auth_or_admin(&env, &user_address, Some(&admin_address))?;
/// ```
pub fn require_auth_or_admin(
    _env: &Env,
    caller: &Address,
    admin: Option<&Address>,
) -> Result<(), Error> {
    if let Some(admin_addr) = admin {
        if *caller == *admin_addr {
            return Ok(());
        }
    }
    caller.require_auth();
    Ok(())
}
