/**
 * @file Calculate Year Income
 * @summary All income sources for a single projection year
 * @description Extracted from _projectionEngine.js (Step 4 of refactor).
 *
 * Computes: Social Security (COLA, ssdi_monthly override, Medicaid seizure),
 * annuity SMA payments (H1/H2 split), rental income (annual increase, trust routing),
 * LTC insurance payouts, roommate income (post-MC, with depreciation).
 */

const { PROJECTION_CONSTANTS } = require('./constants');
const { pow } = require('./deterministic-math');

/**
 * Calculate annual instrument payment (SMA or lump sum).
 * @param {Object} instrument - Financial instrument record
 * @param {number} year - Current year
 * @returns {number} Annual payment amount
 */
function calculateInstrumentPayment(instrument, year) {
    if (!instrument) return 0;

    const startDate = instrument.payment_start_date ? new Date(instrument.payment_start_date) : null;
    const endDate = instrument.payment_end_date ? new Date(instrument.payment_end_date) : null;
    const instStartYear = startDate ? startDate.getFullYear() : 0;
    const instEndYear = endDate ? endDate.getFullYear() : 9999;

    if (year < instStartYear || year > instEndYear) return 0;

    // Lump sum
    if (instrument.type === 'lump_sum') {
        const maturityDate = instrument.maturity_date ? new Date(instrument.maturity_date) : null;
        if (maturityDate && maturityDate.getFullYear() === year) {
            return instrument.face_value || 0;
        }
        return 0;
    }

    // SMA with escalation
    if (instrument.escalation_rate && instrument.escalation_rate > 0) {
        const basePayment = instrument.monthly_payment || 0;
        const yearsElapsed = year - instStartYear;
        const escalatedPayment = basePayment * pow(1 + instrument.escalation_rate, yearsElapsed);
        let monthsInYear = 12;
        if (year === instStartYear && startDate) monthsInYear = 12 - startDate.getMonth();
        if (year === instEndYear && endDate) monthsInYear = Math.min(monthsInYear, endDate.getMonth() + 1);
        return escalatedPayment * monthsInYear;
    }

    // Standard SMA
    const monthlyPayment = instrument.monthly_payment || 0;
    let monthsInYear = 12;
    if (year === instStartYear && startDate) monthsInYear = 12 - startDate.getMonth();
    if (year === instEndYear && endDate) monthsInYear = Math.min(monthsInYear, endDate.getMonth() + 1);
    return monthlyPayment * monthsInYear;
}

/**
 * Calculate LTC insurance payout for a year.
 * @param {Object} policy - LTC policy record
 * @param {number} triggerYear - Year LTC triggered
 * @param {number} year - Current year
 * @returns {number} Annual payout amount
 */
function calculateLTCPayout(policy, triggerYear, year) {
    if (!policy || !triggerYear || year < triggerYear) return 0;

    const yearsFromTrigger = year - triggerYear;
    const payoutYears = policy.payout_days ? policy.payout_days / 365 : 4;
    if (yearsFromTrigger >= payoutYears) return 0;

    const yearsToTrigger = triggerYear - PROJECTION_CONSTANTS.baseYear;
    const inflationRate = policy.pool_inflation_rate || 0.05;
    const poolAtTrigger = policy.current_pool * pow(1 + inflationRate, yearsToTrigger);
    const dailyBenefit = poolAtTrigger / (policy.payout_days || 1460);
    return dailyBenefit * 365;
}

/**
 * Calculate all income for a single year.
 *
 * @param {Object} params
 * @param {number} params.year
 * @param {Object} params.scenario
 * @param {Array} params.incomeSources
 * @param {Array} params.instruments
 * @param {Object} params.ltcPolicy
 * @param {boolean} params.isMAPT
 * @param {boolean} params.medicaidActive
 * @param {number|null} params.medicaidTriggerYear
 * @param {boolean} params.condoSold
 * @param {boolean} params.inMemoryCare
 * @returns {Object} { income, ssdAmount, annualRentalIncome, annuityPayments, roommateDepreciation, deltaBalances, yearData }
 */
function calculateYearIncome(params) {
    const {
        year, scenario, incomeSources, instruments, ltcPolicy,
        isMAPT,
        medicaidActive, medicaidTriggerYear, condoSold, inMemoryCare
    } = params;

    // Per directive 2026-04-06: MAPT is always non-grantor with LPOA.
    // The grantor toggle has been stripped. See decision-log D-011.
    const isNonGrantor = isMAPT;
    const isGrantor = false;

    const income = {};
    const yearData = {};
    const deltaBalances = {};
    let ssdAmount = 0;
    let annualRentalIncome = 0;
    let hasRentalIncome = false;
    let roommateDepreciation = 0;

    // --- Social Security ---
    const ssIncome = incomeSources.find(i => i.source_type === 'social_security');
    if (ssIncome && year >= (ssIncome.start_year || 0) && (!ssIncome.end_year || year <= ssIncome.end_year)) {
        const baseAmount = scenario.ssdi_monthly ? scenario.ssdi_monthly * 12 : (ssIncome.annual_amount || 36000);
        // SSDI COLA default: 2%/yr. Per 2026-04-07 research, SSA COLA has
        // run 2.5–3% in recent adjustments and is projected at 2.5–3% for
        // the next few years. 2% is a defensible floor that avoids
        // overstating future SS income under uncertain macro conditions.
        const colaRate = ssIncome.cola_rate != null ? ssIncome.cola_rate : 0.02;
        // Base year for COLA compounding defaults to 2026 (the projection
        // base year). Year 2026 → 0 rounds, 2027 → 1 round, etc. This
        // reflects the intent that the base amount is quoted in 2026
        // dollars and COLA begins applying immediately in 2027.
        const baseYear = ssIncome.start_year != null ? ssIncome.start_year : 2026;
        const yearsFromStart = Math.max(0, year - baseYear);
        ssdAmount = baseAmount * pow(1 + colaRate, yearsFromStart);
        income.ssdi = ssdAmount;
    }

    if (medicaidActive) {
        if (year === medicaidTriggerYear) {
            ssdAmount = ssdAmount / 12;
        } else {
            ssdAmount = 0;
        }
        income.ssdi = ssdAmount;
        yearData.ss_seized = true;
    }

    // --- Annuity SMA Payments (H1/H2 split) ---
    let annuityPayments = 0;
    let annuityPaymentsH1 = 0;
    let annuityPaymentsH2 = 0;
    if (!medicaidActive) {
        instruments.forEach(inst => {
            if (inst.type.includes('sma') || inst.type === 'lump_sum') {
                const payment = calculateInstrumentPayment(inst, year);
                if (payment > 0) {
                    annuityPayments += payment;
                    if (inst.type === 'lump_sum') {
                        const matDate = inst.maturity_date ? new Date(inst.maturity_date) : null;
                        if (matDate && matDate.getMonth() >= 6) {
                            annuityPaymentsH2 += payment;
                        } else {
                            annuityPaymentsH1 += payment;
                        }
                    } else {
                        // SMA: split by months in each half
                        const startDate = inst.payment_start_date ? new Date(inst.payment_start_date) : null;
                        const endDate = inst.payment_end_date ? new Date(inst.payment_end_date) : null;
                        const instStartYear = startDate ? startDate.getFullYear() : 0;
                        const instEndYear = endDate ? endDate.getFullYear() : 9999;
                        let h1Months = 6, h2Months = 6;
                        if (year === instStartYear && startDate) {
                            const startMonth = startDate.getMonth();
                            h1Months = Math.max(0, 6 - startMonth);
                            h2Months = Math.max(0, Math.min(6, 12 - Math.max(startMonth, 6)));
                        }
                        if (year === instEndYear && endDate) {
                            const endMonth = endDate.getMonth();
                            h1Months = Math.min(h1Months, endMonth + 1);
                            h2Months = Math.min(h2Months, Math.max(0, endMonth - 5));
                        }
                        const totalMonths = h1Months + h2Months;
                        if (totalMonths > 0) {
                            annuityPaymentsH1 += payment * h1Months / totalMonths;
                            annuityPaymentsH2 += payment * h2Months / totalMonths;
                        }
                    }
                }
            }
        });
    }
    yearData.annuity_payments = annuityPayments;
    yearData.annuity_payments_h1 = Math.round(annuityPaymentsH1);
    yearData.annuity_payments_h2 = Math.round(annuityPaymentsH2);
    deltaBalances.sdiraCheckingBalance = annuityPayments;

    // --- Rental Income ---
    const rentalSource = incomeSources.find(i => i.source_type === 'rental_income');
    if (!condoSold && rentalSource && year >= (rentalSource.start_year || 0) && (!rentalSource.end_year || year <= rentalSource.end_year)) {
        const monthlyRental = scenario.rental_income_monthly || (rentalSource.annual_amount / 12);
        const baseAnnualRental = monthlyRental * 12;
        const rentalIncreaseRate = scenario.rental_increase_rate || 0.04;
        const rentalIncreaseStartYear = 2028;
        const yearsOfIncrease = Math.max(0, year - rentalIncreaseStartYear + 1);
        annualRentalIncome = yearsOfIncrease > 0
            ? baseAnnualRental * pow(1 + rentalIncreaseRate, yearsOfIncrease)
            : baseAnnualRental;
        income.rental = annualRentalIncome;
        yearData.rental_increase_years = yearsOfIncrease;
        hasRentalIncome = true;
    }

    // LEDGER-REFACTOR: rental cash routing to the MAPT is now owned by
    // `_buildMaptLedger.js` + `_calculateTrustOperations.js` as the single
    // source of truth. Bug1 fix: rental stays in MAPT regardless of trust_type
    // (cash vs tax attribution decoupling).
    // See: docs/ledger-refactor/PRD-ledger-refactor.md §4.2, §5.1
    // We still surface the field for display continuity.
    if (isMAPT && hasRentalIncome) {
        yearData.rental_to_trust = annualRentalIncome;
    }

    // --- LTC Payout ---
    if (!medicaidActive && ltcPolicy && scenario.ltc_trigger_year && year >= scenario.ltc_trigger_year) {
        const ltcAmount = calculateLTCPayout(ltcPolicy, scenario.ltc_trigger_year, year);
        if (ltcAmount > 0) {
            income.ltc_payout = ltcAmount;
            deltaBalances.ltcSavingsBalance = (deltaBalances.ltcSavingsBalance || 0) + ltcAmount;
        }
    }

    // --- Roommate Income (MAPT only, post-MC) ---
    // Per directive 2026-04-06: roommate income flows to the MAPT (non-grantor
    // trust) where it is sequestered from Person A's 1040. The grantor-path
    // C3-direct-pay workaround has been removed along with the grantor toggle.
    // Roommates are taken starting at memory care, when bedrooms free up.
    // See: docs/ledger-refactor/decision-log.md D-011
    let roommateIncome = 0;
    if (isMAPT && scenario.roommate_enabled === 1 && inMemoryCare) {
        roommateIncome = (scenario.roommate_monthly || 1100) * 12;
        income.roommate = roommateIncome;
        const rentedPortion = 0.50;
        const houseBasis = scenario.primary_house_basis || 500000;
        const buildingValue = houseBasis * 0.80;
        roommateDepreciation = (buildingValue * rentedPortion) / 27.5;
        yearData.roommate_depreciation = roommateDepreciation;
    }

    return {
        income,
        ssdAmount,
        annualRentalIncome,
        hasRentalIncome,
        annuityPayments,
        roommateIncome,
        roommateDepreciation,
        deltaBalances,
        yearData
    };
}

module.exports = { calculateYearIncome, calculateInstrumentPayment, calculateLTCPayout };
