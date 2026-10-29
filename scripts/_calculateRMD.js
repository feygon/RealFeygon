/**
 * @file _calculateRMD.js
 * @description Pure function for Required Minimum Distribution calculation.
 *   Extracted from NickersonCallbacks for use by both the projection engine
 *   and the DP withdrawal optimizer.
 *
 * @DECISION Uses IRS Uniform Lifetime Table (ages 73-90). Person A born 1955,
 *   RMD starts 2028 (age 73). Factors from IRS Publication 590-B (2024).
 */

const { PROJECTION_CONSTANTS } = require('./constants');
const { pow } = require('./deterministic-math');

// IRS Uniform Lifetime Table factors (ages 73-90)
const RMD_FACTORS = {
    73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9,
    78: 22.0, 79: 21.1, 80: 20.2, 81: 19.4, 82: 18.5,
    83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4,
    88: 13.7, 89: 12.9, 90: 12.2
};

const RMD_START_YEAR = 2028; // Age 73 for Person A (born July 1955, turns 73 in July 2028)

/**
 * Calculate Required Minimum Distribution for a given year and IRA balance.
 *
 * @param {number} year - Projection year
 * @param {number} iraBalance - Total IRA balance at start of year
 * @returns {number} Required minimum distribution (0 if not yet required)
 */
function calculateRMD(year, iraBalance) {
    if (year < RMD_START_YEAR || !iraBalance || iraBalance <= 0) return 0;

    const age = PROJECTION_CONSTANTS.baseYearAgeA + (year - PROJECTION_CONSTANTS.baseYear);
    const factor = RMD_FACTORS[age];
    if (!factor) return 0;

    return iraBalance / factor;
}

/**
 * Legacy compatibility: calculate RMD from account objects (used by NickersonCallbacks shim).
 *
 * @param {Array} accounts - Array of account objects with { balance, rmd_required }
 * @param {number} year - Projection year
 * @param {Object} rateSet - Rate set with ira_growth_rate
 * @returns {number} Total RMD across all accounts
 */
function calculateRMDFromAccounts(accounts, year, rateSet) {
    if (!accounts || accounts.length === 0) return 0;
    if (year < RMD_START_YEAR) return 0;

    const age = PROJECTION_CONSTANTS.baseYearAgeA + (year - PROJECTION_CONSTANTS.baseYear);
    const factor = RMD_FACTORS[age];
    if (!factor) return 0;

    let totalRMD = 0;
    accounts.forEach(account => {
        if (account.rmd_required) {
            const yearsElapsed = year - PROJECTION_CONSTANTS.baseYear;
            const growthRate = rateSet?.ira_growth_rate || 0.04;
            const estimatedBalance = account.balance * pow(1 + growthRate, yearsElapsed);
            totalRMD += estimatedBalance / factor;
        }
    });

    return totalRMD;
}

module.exports = { calculateRMD, calculateRMDFromAccounts, RMD_FACTORS, RMD_START_YEAR };
