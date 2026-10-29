/**
 * Mortgage Payment Calculation Module
 *
 * Calculates mortgage payments for the dual-mortgage system:
 * - Primary house: 15-year interest-only balloon at 5.7%
 * - Condo: 30-year fixed P&I at 6.3%
 *
 * Extracted from NickersonCallbacks.js (Phase B: Separation of Concerns)
 *
 * CRITICAL: Per PROPERTY-CHEAT-SHEET.md:
 * - BOTH mortgages go to Schedule A (personal residences)
 * - Primary house mortgage: interest-only (no principal reduction)
 * - Condo mortgage: 30-year P&I amortization (C2 lives there, NOT rented)
 * - Arbor Roses has NO mortgage (owned free and clear)
 *
 * @module _calculateMortgagePayments
 */

const { pow } = require('./deterministic-math');

/**
 * Calculate monthly P&I payment for fixed-rate mortgage
 *
 * Formula: M = P * [r(1+r)^n] / [(1+r)^n - 1]
 * Where:
 *   M = monthly payment
 *   P = principal
 *   r = monthly interest rate (annual / 12)
 *   n = number of monthly payments
 *
 * @param {number} principal - Loan principal
 * @param {number} annualRate - Annual interest rate (decimal, e.g., 0.063 for 6.3%)
 * @param {number} years - Loan term in years
 *
 * @returns {number} Monthly P&I payment
 */
function calculateMonthlyPIPayment(principal, annualRate, years) {
    if (principal <= 0) return 0;
    if (annualRate <= 0) return principal / (years * 12);  // Edge case: 0% interest

    const n = years * 12;  // Total number of monthly payments
    const r = annualRate / 12;  // Monthly interest rate

    // Standard mortgage payment formula
    const monthlyPayment = principal * (r * pow(1 + r, n)) / (pow(1 + r, n) - 1);

    return monthlyPayment;
}

/**
 * Calculate dual mortgage payments for a single year
 *
 * @param {Object} params
 * @param {number} params.primaryMortgageBalance - Primary house mortgage balance
 * @param {number} params.primaryMortgageRate - Primary mortgage annual interest rate (decimal)
 * @param {number} params.condoMortgageBalance - Condo mortgage balance
 * @param {number} params.condoMortgageRate - Condo mortgage annual interest rate (decimal)
 * @param {number} params.condoMortgageMonthlyPayment - Precomputed monthly P&I payment for Condo mortgage
 *
 * @returns {Object} Mortgage payment breakdown
 * @returns {number} return.primary_interest - Primary mortgage interest (full payment, no principal)
 * @returns {number} return.primary_principal - Primary mortgage principal (always 0 for IO)
 * @returns {number} return.condo_interest - Condo mortgage interest portion
 * @returns {number} return.condo_principal - Condo mortgage principal portion
 * @returns {number} return.total_interest - Total interest across both mortgages (Schedule A)
 * @returns {number} return.total_principal - Total principal paid (only SNT)
 * @returns {number} return.total_payment - Total mortgage payment
 * @returns {number} return.new_primary_balance - Updated primary balance (unchanged for IO)
 * @returns {number} return.new_condo_balance - Updated SNT balance after principal payment
 * @returns {number} return.new_total_balance - Combined new balance
 */
function calculateMortgagePayments({
    primaryMortgageBalance,
    primaryMortgageRate,
    condoMortgageBalance,
    condoMortgageRate,
    condoMortgageMonthlyPayment
}) {
    // Validate inputs
    if (typeof primaryMortgageBalance !== 'number' || primaryMortgageBalance < 0) {
        throw new Error('Invalid primaryMortgageBalance: must be non-negative number');
    }
    if (typeof condoMortgageBalance !== 'number' || condoMortgageBalance < 0) {
        throw new Error('Invalid condoMortgageBalance: must be non-negative number');
    }

    let primary_interest = 0;
    let primary_principal = 0;
    let condo_interest = 0;
    let condo_principal = 0;
    let new_primary_balance = primaryMortgageBalance;
    let new_condo_balance = condoMortgageBalance;

    // Primary house mortgage: interest-only (no principal reduction)
    if (primaryMortgageBalance > 0) {
        primary_interest = primaryMortgageBalance * primaryMortgageRate;
        primary_principal = 0;  // Interest-only: no principal paid
        // Balance unchanged (balloon payment due at maturity)
        new_primary_balance = primaryMortgageBalance;
    }

    // Condo mortgage: 30-year fixed P&I amortization
    if (condoMortgageBalance > 0 && condoMortgageMonthlyPayment > 0) {
        const condoAnnualPayment = condoMortgageMonthlyPayment * 12;
        const condoAnnualInterest = condoMortgageBalance * condoMortgageRate;

        // Principal = payment - interest (capped at remaining balance for final payment)
        const condoAnnualPrincipal = Math.min(
            condoAnnualPayment - condoAnnualInterest,
            condoMortgageBalance
        );

        condo_interest = condoAnnualInterest;
        condo_principal = condoAnnualPrincipal;

        // Reduce balance by principal paid
        new_condo_balance = Math.max(0, condoMortgageBalance - condoAnnualPrincipal);
    }

    // Totals
    const total_interest = primary_interest + condo_interest;
    const total_principal = primary_principal + condo_principal;
    const total_payment = total_interest + total_principal;
    const new_total_balance = new_primary_balance + new_condo_balance;

    return {
        // Primary mortgage (interest-only)
        primary_interest,
        primary_principal,
        // Condo mortgage (P&I)
        condo_interest,
        condo_principal,
        // Totals
        total_interest,
        total_principal,
        total_payment,
        // Updated balances
        new_primary_balance,
        new_condo_balance,
        new_total_balance
    };
}

/**
 * Initialize mortgage system at start of projection
 *
 * @param {Object} params
 * @param {number} params.totalMortgage - Total mortgage amount (e.g., $300,000)
 * @param {number} params.splitPct - Percentage allocated to primary house (e.g., 0.80 for 80/20 split)
 * @param {number} params.primaryRate - Primary mortgage annual rate (e.g., 0.057 for 5.7%)
 * @param {number} params.condoRate - Condo mortgage annual rate (e.g., 0.063 for 6.3%)
 * @param {number} params.condoTermYears - Condo mortgage term in years (default 30)
 *
 * @returns {Object} Initial mortgage configuration
 * @returns {number} return.primaryMortgageBalance - Initial primary balance
 * @returns {number} return.condoMortgageBalance - Initial SNT balance
 * @returns {number} return.condoMortgageMonthlyPayment - Monthly P&I payment for SNT
 * @returns {number} return.totalMortgageBalance - Combined initial balance
 * @returns {number} return.primaryMortgageRate - Primary rate (for reference)
 * @returns {number} return.condoMortgageRate - SNT rate (for reference)
 */
function initializeMortgages({
    totalMortgage,
    splitPct,
    primaryRate,
    condoRate,
    condoTermYears = 30
}) {
    // Split mortgage between primary and SNT
    const primaryMortgageBalance = Math.round(totalMortgage * splitPct);
    const condoMortgageBalance = totalMortgage - primaryMortgageBalance;

    // Calculate SNT monthly P&I payment
    const condoMortgageMonthlyPayment = calculateMonthlyPIPayment(
        condoMortgageBalance,
        condoRate,
        condoTermYears
    );

    return {
        primaryMortgageBalance,
        condoMortgageBalance,
        condoMortgageMonthlyPayment,
        totalMortgageBalance: totalMortgage,
        primaryMortgageRate: primaryRate,
        condoMortgageRate: condoRate
    };
}

module.exports = {
    calculateMortgagePayments,
    calculateMonthlyPIPayment,
    initializeMortgages
};
