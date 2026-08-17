extern crate afri_contract_shared;

use afri_contract_shared::{checked_mul_div, Error};

// ---------------------------------------------------------------------------
// Normal calculations
// ---------------------------------------------------------------------------

#[test]
fn basic_percentage() {
    // 50% of 1000 = 500
    assert_eq!(checked_mul_div(1000, 50, 100), Ok(500));
}

#[test]
fn full_amount() {
    // 100% of 1000 = 1000
    assert_eq!(checked_mul_div(1000, 100, 100), Ok(1000));
}

#[test]
fn zero_percent() {
    // 0% of 1000 = 0
    assert_eq!(checked_mul_div(1000, 0, 100), Ok(0));
}

#[test]
fn zero_amount() {
    // 0 * anything / anything = 0
    assert_eq!(checked_mul_div(0, 50, 100), Ok(0));
}

#[test]
fn one_to_one() {
    // amount * 1 / 1 = amount
    assert_eq!(checked_mul_div(42, 1, 1), Ok(42));
}

#[test]
fn large_values_within_range() {
    // 1_000_000 * 3 / 4 = 750_000
    assert_eq!(checked_mul_div(1_000_000, 3, 4), Ok(750_000));
}

// ---------------------------------------------------------------------------
// Division by zero
// ---------------------------------------------------------------------------

#[test]
fn zero_denominator_returns_overflow() {
    assert_eq!(checked_mul_div(1000, 1, 0), Err(Error::Overflow));
}

#[test]
fn zero_denominator_with_zero_amount() {
    // Even 0 * 0 / 0 is an error (division by zero).
    assert_eq!(checked_mul_div(0, 0, 0), Err(Error::Overflow));
}

// ---------------------------------------------------------------------------
// Overflow detection
// ---------------------------------------------------------------------------

#[test]
fn multiplication_overflows() {
    let max = i128::MAX;
    assert_eq!(checked_mul_div(max, 2, 1), Err(Error::Overflow));
}

#[test]
fn negative_numerator_overflows() {
    // i128::MIN * -1 overflows (i128::MIN is -2^127, * -1 = 2^127 > i128::MAX)
    let min = i128::MIN;
    assert_eq!(checked_mul_div(1, min, 1), Err(Error::Overflow));
}

#[test]
fn large_product_that_fits() {
    // 10^18 * 10^18 / 10^18 = 10^18 (should succeed)
    let large = 1_000_000_000_000_000_000_i128;
    assert_eq!(checked_mul_div(large, large, large), Ok(large));
}

// ---------------------------------------------------------------------------
// Negative values (i128 permits them)
// ---------------------------------------------------------------------------

#[test]
fn negative_amount() {
    // -1000 * 50 / 100 = -500
    assert_eq!(checked_mul_div(-1000, 50, 100), Ok(-500));
}

#[test]
fn negative_numerator() {
    // 1000 * -1 / 10 = -100
    assert_eq!(checked_mul_div(1000, -1, 10), Ok(-100));
}

#[test]
fn negative_denominator() {
    // 1000 * 50 / -100 = -500
    assert_eq!(checked_mul_div(1000, 50, -100), Ok(-500));
}

#[test]
fn double_negative_yields_positive() {
    // 1000 * -50 / -100 = 500
    assert_eq!(checked_mul_div(1000, -50, -100), Ok(500));
}

// ---------------------------------------------------------------------------
// Boundary values
// ---------------------------------------------------------------------------

#[test]
fn max_amount_times_one() {
    assert_eq!(checked_mul_div(i128::MAX, 1, 1), Ok(i128::MAX));
}

#[test]
fn max_amount_times_one_divided_by_two() {
    // i128::MAX is odd, so /2 truncates
    assert_eq!(checked_mul_div(i128::MAX, 1, 2), Ok(i128::MAX / 2));
}

#[test]
fn one_times_max_numerator() {
    assert_eq!(checked_mul_div(1, i128::MAX, 1), Ok(i128::MAX));
}
