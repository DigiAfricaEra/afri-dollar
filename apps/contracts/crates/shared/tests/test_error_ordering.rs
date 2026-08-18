extern crate afri_contract_shared;

use afri_contract_shared::Error;

/// Verify that all Error discriminants are stable and match their
/// documented values. This test prevents accidental reordering.
#[test]
fn error_discriminants_are_stable() {
    // Original upgrade/auth variants — must never change.
    assert_eq!(Error::AlreadyInitialized as u32, 1);
    assert_eq!(Error::NotInitialized as u32, 2);
    assert_eq!(Error::Unauthorized as u32, 3);
    assert_eq!(Error::UpgradeAlreadyPending as u32, 4);
    assert_eq!(Error::NoPendingUpgrade as u32, 5);
    assert_eq!(Error::UpgradeTimelockNotElapsed as u32, 6);
    assert_eq!(Error::InvalidVersion as u32, 7);

    // Cross-cutting variants appended in Issue #164.
    assert_eq!(Error::InvalidAmount as u32, 8);
    assert_eq!(Error::Overflow as u32, 9);
    assert_eq!(Error::AssetNotFound as u32, 10);
    assert_eq!(Error::InsufficientBalance as u32, 11);
    assert_eq!(Error::Expired as u32, 12);
}

/// Verify that the enum is ordered (Ord) and variants sort by discriminant.
#[test]
fn error_variants_sort_by_discriminant() {
    let mut variants = [
        Error::AlreadyInitialized,
        Error::InvalidAmount,
        Error::Expired,
        Error::Unauthorized,
        Error::InsufficientBalance,
        Error::Overflow,
        Error::NotInitialized,
        Error::AssetNotFound,
        Error::InvalidVersion,
        Error::UpgradeAlreadyPending,
        Error::UpgradeTimelockNotElapsed,
        Error::NoPendingUpgrade,
    ];
    variants.sort();
    let expected = [
        Error::AlreadyInitialized,
        Error::NotInitialized,
        Error::Unauthorized,
        Error::UpgradeAlreadyPending,
        Error::NoPendingUpgrade,
        Error::UpgradeTimelockNotElapsed,
        Error::InvalidVersion,
        Error::InvalidAmount,
        Error::Overflow,
        Error::AssetNotFound,
        Error::InsufficientBalance,
        Error::Expired,
    ];
    assert_eq!(variants, expected);
}

/// Verify that each variant is distinct (no duplicate discriminants).
#[test]
fn error_variants_are_distinct() {
    let all = [
        Error::AlreadyInitialized,
        Error::NotInitialized,
        Error::Unauthorized,
        Error::UpgradeAlreadyPending,
        Error::NoPendingUpgrade,
        Error::UpgradeTimelockNotElapsed,
        Error::InvalidVersion,
        Error::InvalidAmount,
        Error::Overflow,
        Error::AssetNotFound,
        Error::InsufficientBalance,
        Error::Expired,
    ];
    for (i, a) in all.iter().enumerate() {
        for (j, b) in all.iter().enumerate() {
            if i != j {
                assert_ne!(a, b, "variants at index {} and {} are equal", i, j);
            }
        }
    }
}
