use soroban_sdk::contracterror;

/// Cross-cutting error enum for all AfriDollar Soroban contracts.
///
/// # Discriminant stability
///
/// Variants are assigned explicit `repr(u32)` discriminants. **Existing
/// discriminants must never be reordered or renumbered** — downstream
/// contracts and off-chain consumers depend on their numeric values.
/// New variants MUST always be appended at the end with a new discriminant.
///
/// Contracts that need domain-specific errors should keep a local error
/// enum and map only the overlapping variants to this shared enum.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that is already initialized.
    AlreadyInitialized = 1,
    /// An operation was attempted before the contract was initialized.
    NotInitialized = 2,
    /// The caller is not authorized to perform the operation.
    Unauthorized = 3,
    /// An upgrade proposal already exists and has not been resolved.
    UpgradeAlreadyPending = 4,
    /// No pending upgrade proposal was found for the given ID.
    NoPendingUpgrade = 5,
    /// The upgrade timelock has not yet elapsed.
    UpgradeTimelockNotElapsed = 6,
    /// The contract version is invalid or unrecognized.
    InvalidVersion = 7,

    // --- Cross-cutting variants appended below ---
    // These follow the existing upgrade/auth variants. Do NOT insert
    // variants above this comment; always append at the end.
    /// An amount argument was zero, negative, or otherwise invalid.
    InvalidAmount = 8,
    /// A checked arithmetic operation would have overflowed.
    Overflow = 9,
    /// The requested asset was not found or is not configured.
    AssetNotFound = 10,
    /// The caller has insufficient balance for the requested operation.
    InsufficientBalance = 11,
    /// A time-bound resource (allowance, proposal, etc.) has expired.
    Expired = 12,
}
