use crate::Error;

/// Checked wide-intermediate `amount * numerator / denominator`.
///
/// Performs the multiplication first using `i128` to avoid truncation,
/// then divides. Returns [`Error::Overflow`] if the intermediate product
/// exceeds `i128::MAX` or if `denominator` is zero.
///
/// # Arguments
///
/// * `amount` — base value (e.g. total supply, total amount).
/// * `numerator` — proportional numerator (e.g. elapsed time, percentage).
/// * `denominator` — proportional denominator (e.g. total duration, 100).
///
/// # Panics
///
/// This function never panics; it returns `Err` on overflow or
/// division by zero.
///
/// # Examples
///
/// ```rust,ignore
/// // 50% of 1000 = 500
/// assert_eq!(checked_mul_div(1000, 50, 100), Ok(500));
/// // Division by zero
/// assert_eq!(checked_mul_div(1000, 1, 0), Err(Error::Overflow));
/// ```
pub fn checked_mul_div(amount: i128, numerator: i128, denominator: i128) -> Result<i128, Error> {
    if denominator == 0 {
        return Err(Error::Overflow);
    }
    amount
        .checked_mul(numerator)
        .ok_or(Error::Overflow)?
        .checked_div(denominator)
        .ok_or(Error::Overflow)
}
