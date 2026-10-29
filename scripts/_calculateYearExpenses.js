/**
 * @file Calculate Year Expenses
 * @summary Non-tax expense calculations for a single projection year
 * @description Extracted from _projectionEngine.js.
 *
 * Computes: property expense routing (isPropertyExpense), MAPT vs Person A split,
 * management fee, condo maintenance, dual mortgage payments, memory care
 * (with Medicaid 1/12 transition), HELOC interest, and MAPT trust/SNT deductions.
 */

const { calculateMortgagePayments } = require('./_calculateMortgagePayments');
const { PROJECTION_CONSTANTS } = require('./constants');
const { pow } = require('./deterministic-math');

/**
 * Calculate expense for a given year with inflation.
 * Inlined from NickersonCallbacks._calculateExpense.
 *
 * @param {Object} expense - Expense record
 * @param {number} year - Current projection year
 * @param {number} startYear - Projection start year
 * @returns {number} Inflated annual expense amount
 */
function calculateExpense(expense, year, startYear) {
    if (!expense) return 0;
    const baseAmount = expense.annual_amount || 0;
    const inflationRate = expense.inflation_rate || 0;
    const yearsElapsed = year - startYear;
    return baseAmount * pow(1 + inflationRate, yearsElapsed);
}

/**
 * Calculate memory care expense.
 * Inlined from NickersonCallbacks._calculateMemoryCare.
 * Inflates from base year (configured in PROJECTION_CONSTANTS), not from start year.
 *
 * @param {Object} scenario - Scenario configuration
 * @param {number} year - Current projection year
 * @param {Object} rateSet - Rate assumptions
 * @param {number} startYear - Memory care start year
 * @returns {number} Annual memory care cost
 */
function calculateMemoryCare(scenario, year, rateSet, startYear) {
    const baseCost = scenario.memory_care_cost || 120000;
    const inflationRate = scenario.memory_care_inflation || rateSet?.memory_care_inflation || 0.05;
    const baseYear = PROJECTION_CONSTANTS.baseYear;

    if (!startYear || year < startYear) return 0;

    const yearsFromBase = year - baseYear;
    return baseCost * pow(1 + inflationRate, yearsFromBase);
}

/**
 * Calculate all non-tax expenses for a single projection year.
 *
 * @param {Object} params
 * @param {number} params.year - Current projection year
 * @param {number} params.startYear - Projection start year
 * @param {Array}  params.expenses - Expense records
 * @param {Object} params.scenario - Scenario configuration
 * @param {Object} params.rateSet - Rate assumptions
 * @param {boolean} params.isMAPT - Whether this is a MAPT scenario
 * @param {boolean} params.inMemoryCare - Whether Person A is in memory care
 * @param {boolean} params.medicaidActive - Whether Medicaid is active
 * @param {number|null} params.medicaidTriggerYear - Year Medicaid activates
 * @param {boolean} params.condoSold - Whether the condo has been sold
 * @param {boolean} params.hasRentalIncome - Whether there is rental income
 * @param {number} params.annualRentalIncome - Annual rental income amount
 * @param {number} params.primaryMortgageBalance - Primary mortgage balance
 * @param {number} params.primaryMortgageRate - Primary mortgage interest rate
 * @param {number} params.condoMortgageBalance - Condo mortgage balance
 * @param {number} params.condoMortgageRate - Condo mortgage interest rate
 * @param {number} params.condoMortgageMonthlyPayment - Condo monthly mortgage payment
 * @param {number|null} params.memoryCareStartYear - Year memory care begins
 * @param {number} params.helocBalance - HELOC balance
 * @param {number} params.helocRate - HELOC interest rate
 * @param {number} params.trustBalance - MAPT trust checking balance
 * @param {number} params.sntBalance - SNT balance
 * @returns {Object} Result with expenses, fixedExpenses, maptPropertyExpenses,
 *   memoryCareAmount, totalMortgageInterest, deltaBalances, setBalances, yearData
 */
function calculateYearExpenses(params) {
    const {
        year, startYear, expenses, scenario, rateSet,
        isMAPT, inMemoryCare, medicaidActive, medicaidTriggerYear,
        condoSold, hasRentalIncome, annualRentalIncome,
        primaryMortgageBalance, primaryMortgageRate,
        condoMortgageBalance, condoMortgageRate, condoMortgageMonthlyPayment,
        memoryCareStartYear,
        helocBalance, helocRate,
        trustBalance, sntBalance
    } = params;

    const yearDataExpenses = {};
    const yearDataFields = {};
    const deltaBalances = {};
    const setBalances = {};

    let fixedExpenses = 0;
    let maptPropertyExpenses = 0;

    // Determine if an expense is a MAPT trust expense.
    //
    // LEDGER-REFACTOR NOTE: Residency routing for primary carrying costs
    // (the `inMemoryCare` gate below) is correct and must be preserved.
    // For MAPT scenarios, this classifier routes the expense AWAY from
    // Person A's `fixedExpenses` accumulator; the authoritative trust-side
    // arithmetic is then performed by _buildMaptLedger + _calculateTrustOperations.
    // See: docs/ledger-refactor/PRD-ledger-refactor.md §5.4
    function isPropertyExpense(exp) {
        if (!exp.expense_type) return false;
        if (exp.expense_type.includes('condo') ||
            exp.expense_type === 'management_fee' ||
            exp.expense_type === 'mortgage_payment') {
            return true;
        }
        if (exp.expense_type === 'primary_carrying' && inMemoryCare) {
            return true;
        }
        return false;
    }

    // Process each expense record
    expenses.forEach(exp => {
        if (condoSold && exp.expense_type && exp.expense_type.includes('condo')) {
            return;
        }
        if (exp.id === 'EX_MORTGAGE' || exp.expense_type === 'mortgage_payment') {
            return;
        }
        if (exp.expense_type === 'management_fee') {
            return;
        }
        if (exp.expense_type === 'lifestyle') {
            return;
        }

        if (year >= (exp.start_year || 0) && (!exp.end_year || year <= exp.end_year)) {
            const amount = calculateExpense(exp, year, startYear);

            if (amount > 0) {
                const key = (exp.name || exp.id).toLowerCase().replace(/\s+/g, '_');
                yearDataExpenses[key] = amount;

                if (isMAPT && isPropertyExpense(exp)) {
                    maptPropertyExpenses += amount;
                } else {
                    fixedExpenses += amount;
                }
            }
        }
    });

    // Management fee (calculated as percentage of rental income)
    if (hasRentalIncome && annualRentalIncome > 0) {
        const managementFeeRate = scenario.management_fee || 0.08;
        const managementFeeAmount = annualRentalIncome * managementFeeRate;
        yearDataExpenses.management_fee = managementFeeAmount;
        if (isMAPT) {
            maptPropertyExpenses += managementFeeAmount;
        } else {
            fixedExpenses += managementFeeAmount;
        }
    }

    // Condo maintenance (slider-controlled, skipped if condo sold)
    if (!condoSold) {
        const condoMaintenance = scenario.condo_maintenance || 2400;
        const condoMaintenanceAmount = condoMaintenance * pow(1.03, year - startYear);
        yearDataExpenses.condo_maintenance = condoMaintenanceAmount;
        if (isMAPT) {
            maptPropertyExpenses += condoMaintenanceAmount;
        } else {
            fixedExpenses += condoMaintenanceAmount;
        }
    }

    // Dual mortgage payments
    let totalMortgageInterest = 0;
    let totalMortgagePrincipal = 0;
    let totalMortgagePayment = 0;
    let newPrimaryMortgageBalance = primaryMortgageBalance;
    let newCondoMortgageBalance = condoMortgageBalance;
    let newMortgageBalance = primaryMortgageBalance + condoMortgageBalance;

    if (primaryMortgageBalance > 0 || condoMortgageBalance > 0) {
        const mortgagePayment = calculateMortgagePayments({
            primaryMortgageBalance,
            primaryMortgageRate,
            condoMortgageBalance,
            condoMortgageRate,
            condoMortgageMonthlyPayment
        });

        if (mortgagePayment.primary_interest > 0) {
            yearDataExpenses.primary_mortgage_interest = mortgagePayment.primary_interest;
        }
        if (mortgagePayment.condo_interest > 0) {
            yearDataExpenses.condo_mortgage_interest = mortgagePayment.condo_interest;
        }
        if (mortgagePayment.condo_principal > 0) {
            yearDataExpenses.condo_mortgage_principal = mortgagePayment.condo_principal;
        }

        totalMortgageInterest = mortgagePayment.total_interest;
        totalMortgagePrincipal = mortgagePayment.total_principal;
        totalMortgagePayment = mortgagePayment.total_payment;

        yearDataExpenses.mortgage_payment_total = totalMortgagePayment;
        if (isMAPT) {
            // LEDGER-REFACTOR: primary mortgage interest is charged to the
            // MAPT by the ledger builder (_buildMaptLedger.js), NOT here.
            // See: docs/ledger-refactor/PRD-ledger-refactor.md §5.1
            const condoMortgagePaymentAmt = (mortgagePayment.condo_interest || 0) + (mortgagePayment.condo_principal || 0);
            if (medicaidActive) {
                // C2 pays from SNT
                deltaBalances.sntBalance = (deltaBalances.sntBalance || 0) - condoMortgagePaymentAmt;
                yearDataFields.snt_condo_mortgage = condoMortgagePaymentAmt;
            } else {
                fixedExpenses += condoMortgagePaymentAmt;
            }
        } else {
            fixedExpenses += totalMortgagePayment;
        }
        yearDataFields.mortgage_principal_paid = totalMortgagePrincipal;

        newPrimaryMortgageBalance = mortgagePayment.new_primary_balance;
        newCondoMortgageBalance = mortgagePayment.new_condo_balance;
        newMortgageBalance = mortgagePayment.new_total_balance;
    }

    setBalances.primaryMortgageBalance = newPrimaryMortgageBalance;
    setBalances.condoMortgageBalance = newCondoMortgageBalance;
    setBalances.mortgageBalance = newMortgageBalance;

    // Memory care expense
    let memoryCareAmount = 0;
    if (inMemoryCare) {
        if (medicaidActive) {
            if (year === medicaidTriggerYear) {
                memoryCareAmount = calculateMemoryCare(scenario, year, rateSet, memoryCareStartYear) / 12;
            } else {
                memoryCareAmount = 0;
            }
            yearDataFields.memory_care_medicaid = true;
        } else {
            memoryCareAmount = calculateMemoryCare(scenario, year, rateSet, memoryCareStartYear);
        }
        yearDataExpenses.memory_care = memoryCareAmount;
        fixedExpenses += memoryCareAmount;
    }

    // HELOC interest expense (on prior year's balance)
    if (helocBalance > 0) {
        const helocInterest = helocBalance * helocRate;
        yearDataExpenses.heloc_interest = helocInterest;
        fixedExpenses += helocInterest;
    }

    // LEDGER-REFACTOR: MAPT property-expense trust arithmetic is now performed
    // by _calculateTrustOperations.js after _buildMaptLedger.js assembles the
    // authoritative ledger. This module no longer touches the trust balance
    // for MAPT scenarios — it only populates `yearData.expenses.*` line items
    // that the ledger builder reads.
    //
    // See: docs/ledger-refactor/PRD-ledger-refactor.md §5.1, §5.4
    if (isMAPT) {
        // Zero out the legacy accumulator so callers can't use a stale value.
        maptPropertyExpenses = 0;
    }

    return {
        expenses: yearDataExpenses,
        fixedExpenses,
        maptPropertyExpenses,
        memoryCareAmount,
        totalMortgageInterest,
        deltaBalances,
        setBalances,
        yearData: yearDataFields
    };
}

module.exports = { calculateYearExpenses, calculateExpense, calculateMemoryCare };
