/**
 * @file _optimizeWithdrawalDP.js
 * @description Backward recursion DP solver for IRA/LTC withdrawal optimization.
 *   Minimizes lifetime tax + IRMAA cost by choosing optimal IRA withdrawal each year.
 *
 *   State: (year, ltc_balance, ira_balance) discretized on a grid.
 *   Decision: W_ira (IRA withdrawal). Remainder comes from LTC savings.
 *   Objective: minimize SUM(taxCost(year, W_ira)) over the projection horizon.
 *
 * @DECISION 2D state (ltc, ira) is sufficient. MAGI-prior-year is derivable from
 *   the decision variable W_ira plus pre-computed known income. No state expansion needed.
 * @DECISION Brackets frozen at 2025/2026 values. Uniform inflation is insensitive to
 *   the IRA/LTC split decision.
 */

const { calculateTaxCost, lookupIRMAA } = require('./_calculateTaxCost');
const { calculateRMD, RMD_START_YEAR } = require('./_calculateRMD');
const { PROJECTION_CONSTANTS, TAX_CONSTANTS } = require('./constants');
const _calculateSSDITaxability = require('./_calculateSSDITaxability');
const { precomputeSurvivalArray } = require('./_survivalProbability');
const { pow } = require('./deterministic-math');

/**
 * @typedef {Object} YearParams
 * @property {number} year
 * @property {number} shortfall        - Total expense shortfall to fund from IRA+LTC
 * @property {number} socialSecurity   - COLA-adjusted SS/SSDI
 * @property {number} rentalIncome     - Rental on 1040 (0 for MAPT)
 * @property {number} medicalExpenses  - Actual medical costs (for wash calculation)
 * @property {number} mortgageInterest - Deductible mortgage interest
 * @property {number} propertyTax      - Property taxes
 * @property {number} ltcPayout        - LTC insurance payout deposited to LTC savings this year
 */

/**
 * @typedef {Object} OptimizerConfig
 * @property {number} [ltcMax=250000]   - Maximum LTC balance on grid
 * @property {number} [iraMax=500000]   - Maximum IRA balance on grid
 * @property {number} [ltcStep=5000]    - LTC grid step
 * @property {number} [iraStep=5000]    - IRA grid step
 * @property {number} [wStep=2000]      - Decision variable step
 * @property {number} [discountRate=0.03] - Time-value discount rate
 */

/**
 * @typedef {Object} OptimizerResult
 * @property {Object.<number, OptimizerDecision>} decisions - Keyed by year
 * @property {number} lifetimeTax         - Total tax under optimal policy
 * @property {number} naiveLifetimeTax    - Total tax under 50/50 policy
 * @property {number} totalSaved          - lifetimeTax - naiveLifetimeTax (negative = savings)
 * @property {number} runtimeMs           - Solve time in milliseconds
 */

/**
 * @typedef {Object} OptimizerDecision
 * @property {number} iraWithdrawal   - Optimal IRA withdrawal
 * @property {number} ltcWithdrawal   - Remainder from LTC savings
 * @property {number} marginalRate    - Effective marginal rate at this level
 * @property {number} irmaaHeadroom   - $ before next IRMAA cliff
 * @property {boolean} washActive     - Medical deduction sheltering IRA income
 * @property {boolean} rmdBinding     - RMD forced higher withdrawal than optimal
 * @property {number} taxSaved        - Tax saved vs naive 50/50 this year
 * @property {number} naiveTax        - What 50/50 would have cost this year
 */

const DEFAULT_CONFIG = {
    ltcMax: 250000,
    iraMax: 500000,
    ltcStep: 5000,
    iraStep: 5000,
    wStep: 2000,
    discountRate: 0.03,
    diagnosisYear: 2026,        // MCI diagnosis year for survival curve
    survivalStage: 'mci_with_reserves',  // AD survival table key
    heirsIrdRate: 0.3075        // Heirs' marginal rate for IRD (22% fed + 8.75% OR)
};

/**
 * Snap a value to the nearest grid index.
 * @param {number} value
 * @param {number} step
 * @param {number} max
 * @returns {number} Grid index (0-based)
 */
function toIndex(value, step, max) {
    return Math.min(Math.round(Math.max(0, value) / step), Math.floor(max / step));
}

/**
 * Convert grid index back to dollar value.
 * @param {number} index
 * @param {number} step
 * @returns {number}
 */
function fromIndex(index, step) {
    return index * step;
}

/**
 * Run the backward recursion DP to find optimal IRA/LTC withdrawal policy.
 *
 * @param {YearParams[]} yearParamsArray - Per-year known values, sorted by year ascending
 * @param {number} startLtc             - Starting LTC savings balance
 * @param {number} startIra             - Starting total IRA balance
 * @param {number} managedIraGrowth     - Annual IRA growth rate (e.g. 0.04)
 * @param {OptimizerConfig} [config]    - Grid configuration
 * @returns {OptimizerResult}
 */
function optimizeWithdrawalDP(yearParamsArray, startLtc, startIra, managedIraGrowth, config) {
    const startTime = Date.now();
    const cfg = { ...DEFAULT_CONFIG, ...config };

    const nLtc = Math.floor(cfg.ltcMax / cfg.ltcStep) + 1;
    const nIra = Math.floor(cfg.iraMax / cfg.iraStep) + 1;
    const nYears = yearParamsArray.length;

    // Value function: V[ltcIdx][iraIdx] = minimum future tax cost from this state
    // We only need current year and next year (rolling 2 layers)
    //
    // Terminal value = 0 (no penalty for remaining IRA at horizon).
    // DECISION: remaining IRA becomes SNT safety net at Medicaid liquidation.
    // Penalizing it would incentivize aggressive depletion, reducing the buffer
    // that protects the primary house from liens post-Medicaid. Tax optimization
    // is secondary to solvency — the optimizer should preserve IRA unless there
    // is a clear, low-risk tax win. The asymmetry is extreme: $500/yr tax savings
    // vs $20k+ in lost SNT funding protecting an $825k house.
    let vNext = createGrid(nLtc, nIra, 0);
    let vCurr = createGrid(nLtc, nIra, 0);

    // Policy table: optimal W_ira for each (year, ltc, ira)
    const policy = new Array(nYears);
    for (let t = 0; t < nYears; t++) {
        policy[t] = createGrid(nLtc, nIra, 0);
    }

    // Pre-compute survival probabilities for the projection horizon
    const firstYear = yearParamsArray[0].year;
    const lastYear = yearParamsArray[nYears - 1].year;
    const survivalProbs = precomputeSurvivalArray(firstYear, lastYear, cfg.diagnosisYear, cfg.survivalStage);

    // Compute W_neutral (wash-neutral IRA amount) per year for bracket harvesting
    // W_neutral = (medical - 0.075 * fixedIncome) / (marginalRate * 1.075)
    // During wash years, this is the max IRA that can be withdrawn at ~0% effective tax
    const wNeutralByYear = {};
    for (let t = 0; t < nYears; t++) {
        const yp = yearParamsArray[t];
        const medical = yp.medicalExpenses || 0;
        const fixedIncome = (yp.socialSecurity || 0) * 0.5 + (yp.rentalIncome || 0); // rough provisional
        const washActive = medical > fixedIncome * 0.075;
        if (washActive && medical > 0) {
            // balanced_wash strategy: cap IRA harvesting at standard deduction
            // Above this, tax starts accruing. The timeline simulation showed this
            // is optimal across all plausible AD timelines — harvests IRA at near-zero
            // tax while preserving LTC (25% more efficient) for the safety net.
            wNeutralByYear[yp.year] = TAX_CONSTANTS.federal.standardDeduction2026;
        } else {
            wNeutralByYear[yp.year] = 0;
        }
    }

    // Backward pass: from last year to first
    for (let t = nYears - 1; t >= 0; t--) {
        const yp = yearParamsArray[t];
        const survProb = survivalProbs[yp.year] || 0;
        const discount = pow(1 / (1 + cfg.discountRate), t);

        // Bracket harvesting ceiling for this year
        const wNeutral = wNeutralByYear[yp.year] || 0;

        for (let li = 0; li < nLtc; li++) {
            const ltcBal = fromIndex(li, cfg.ltcStep);

            for (let ii = 0; ii < nIra; ii++) {
                const iraBal = fromIndex(ii, cfg.iraStep);

                // RMD floor
                const rmd = calculateRMD(yp.year, iraBal);

                // Available LTC this year: current balance + this year's payout
                const ltcAvailable = ltcBal + (yp.ltcPayout || 0);

                // Dynamic shortfall: compute for each W_ira candidate
                // shortfall(W) = fixedExpensesNonTax + tax(W) + lifestyle + charitable + medical - externalIncome
                // We need to explore W_ira from 0 to max(iraBal, W_neutral)
                const maxIra = Math.min(iraBal, Math.max(yp.shortfall, wNeutral));

                // Minimum IRA from RMD (can't go below this)
                const minIra = Math.max(rmd, 0);

                // Check feasibility: can we fund the minimum shortfall?
                // Use precomputed shortfall as baseline for feasibility check
                const baseShortfall = yp.shortfall;
                const minFunding = Math.max(0, baseShortfall - ltcAvailable);
                const effectiveMinIra = Math.max(minIra, minFunding);
                if (effectiveMinIra > iraBal) {
                    vCurr[li][ii] = Infinity;
                    policy[t][li][ii] = iraBal;
                    continue;
                }

                let bestCost = Infinity;
                let bestW = effectiveMinIra;

                // Search over decision variable W_ira
                const wMin = Math.max(0, effectiveMinIra);
                const wMax = Math.min(iraBal, maxIra);

                for (let w = roundToStep(wMin, cfg.wStep); w <= wMax; w += cfg.wStep) {
                    const wIra = Math.max(w, effectiveMinIra);
                    if (wIra > iraBal) break;

                    // Dynamic shortfall: compute tax at this W_ira, derive actual shortfall
                    const taxResult = calculateTaxCost(yp.year, wIra, {
                        socialSecurity: yp.socialSecurity,
                        rentalIncome: yp.rentalIncome || 0,
                        medicalExpenses: yp.medicalExpenses || 0,
                        mortgageInterest: yp.mortgageInterest || 0,
                        propertyTax: yp.propertyTax || 0,
                        charitableContributions: yp.charitableContributions || 0,
                        magi2YearsPrior: yp.magi2YearsPrior || 0
                    });

                    // Dynamic shortfall: actual expenses at this W_ira
                    const dynamicTax = taxResult.federalTax + taxResult.oregonTax + taxResult.irmaaSurcharge;
                    const dynamicExpenses = (yp.fixedExpensesNonTax || 0) + dynamicTax
                        + (yp.lifestyleExpense || 0) + (yp.charitableExpense || 0)
                        + (yp.medicalExpenses || 0);
                    const dynamicShortfall = Math.max(0, dynamicExpenses - (yp.externalIncome || 0));

                    // LTC needed = shortfall minus what IRA covers
                    const wLtc = Math.max(0, dynamicShortfall - wIra);

                    // Can LTC cover its share?
                    if (wLtc > ltcAvailable) continue;

                    // Weight immediate cost by survival probability
                    const immediateCost = taxResult.totalCost * discount * survProb;

                    // LTC preservation premium (balanced_wash strategy):
                    // During wash years, IRA and LTC cost the same per dollar (~$1).
                    // But LTC preserved retains $1 of value forever, while IRA preserved
                    // loses ~25% to tax at liquidation (worth ~$0.75 to the safety net).
                    // Therefore, every dollar of LTC spent during wash when IRA could cover
                    // it wastes $0.25 of safety net value.
                    //
                    // ltcWastePenalty = wLtc * 0.25 * discount (during wash only)
                    // This makes the DP prefer IRA over LTC during wash, up to the
                    // standard deduction cap (wNeutral).
                    const washActive = (yp.medicalExpenses || 0) > 0 && taxResult.washActive;
                    const ltcWastePenalty = (washActive && wLtc > 0)
                        ? wLtc * 0.25 * discount
                        : 0;

                    // Deferred IRMAA: this year's MAGI causes IRMAA surcharge in year t+2
                    // But if year t+2 is at or beyond Medicaid activation (nYears boundary),
                    // the IRMAA is self-funding (deducted from SS before patient pay) — $0 family cost.
                    let deferredIrmaa = 0;
                    if (t + 2 < nYears - 1) {
                        const thisMagi = taxResult.magi;
                        const futureIrmaa = lookupIRMAA(thisMagi);
                        const irmaaDiscount = pow(1 / (1 + cfg.discountRate), t + 2);
                        // Weight deferred IRMAA by survival probability of the IRMAA year
                        const futureSurvProb = survivalProbs[yp.year + 2] || 0;
                        deferredIrmaa = futureIrmaa.surcharge * irmaaDiscount * futureSurvProb;
                    }
                    // Total cost: tax now + deferred IRMAA + LTC waste penalty
                    const immediatePlusDeferred = immediateCost + deferredIrmaa + ltcWastePenalty;

                    // Transition: compute next year's state
                    const nextLtc = ltcAvailable - wLtc;
                    const nextIra = (iraBal - wIra) * (1 + managedIraGrowth);

                    const nextLi = toIndex(nextLtc, cfg.ltcStep, cfg.ltcMax);
                    const nextIi = toIndex(nextIra, cfg.iraStep, cfg.iraMax);

                    const futureCost = vNext[nextLi][nextIi];
                    const totalCost = immediatePlusDeferred + futureCost;

                    if (totalCost < bestCost) {
                        bestCost = totalCost;
                        bestW = wIra;
                    }
                }

                vCurr[li][ii] = bestCost;
                policy[t][li][ii] = bestW;
            }
        }

        // Swap layers
        const tmp = vNext;
        vNext = vCurr;
        vCurr = tmp;
        // Reset current layer for next iteration
        for (let li = 0; li < nLtc; li++) {
            for (let ii = 0; ii < nIra; ii++) {
                vCurr[li][ii] = 0;
            }
        }
    }

    // Forward pass: extract optimal decisions starting from actual balances
    // Run BOTH optimal and naive paths in parallel to get accurate comparison
    const decisions = {};
    let ltcBal = startLtc;
    let iraBal = startIra;
    let naiveLtcBal = startLtc;
    let naiveIraBal = startIra;
    let lifetimeTax = 0;
    let naiveLifetimeTax = 0;
    const magiHistory = [];
    const naiveMagiHistory = [];

    for (let t = 0; t < nYears; t++) {
        const yp = yearParamsArray[t];
        const li = toIndex(ltcBal, cfg.ltcStep, cfg.ltcMax);
        const ii = toIndex(iraBal, cfg.iraStep, cfg.iraMax);

        // === OPTIMAL PATH ===
        let optimalW = policy[t][li][ii];
        const rmd = calculateRMD(yp.year, iraBal);
        const ltcAvailable = ltcBal + (yp.ltcPayout || 0);
        optimalW = Math.max(optimalW, rmd);
        optimalW = Math.min(optimalW, iraBal);

        const magi2Prior = magiHistory.length >= 2
            ? magiHistory[magiHistory.length - 2]
            : (yp.magi2YearsPrior || 0);

        const optTax = calculateTaxCost(yp.year, optimalW, {
            socialSecurity: yp.socialSecurity,
            rentalIncome: yp.rentalIncome || 0,
            medicalExpenses: yp.medicalExpenses || 0,
            mortgageInterest: yp.mortgageInterest || 0,
            propertyTax: yp.propertyTax || 0,
            charitableContributions: yp.charitableContributions || 0,
            magi2YearsPrior: magi2Prior
        });

        // Dynamic shortfall for optimal path
        const optDynamicTax = optTax.federalTax + optTax.oregonTax + optTax.irmaaSurcharge;
        const optDynamicExpenses = (yp.fixedExpensesNonTax || 0) + optDynamicTax
            + (yp.lifestyleExpense || 0) + (yp.charitableExpense || 0) + (yp.medicalExpenses || 0);
        const optDynamicShortfall = Math.max(0, optDynamicExpenses - (yp.externalIncome || 0));
        // Ensure IRA covers at least the gap LTC can't
        optimalW = Math.max(optimalW, Math.max(0, optDynamicShortfall - ltcAvailable));
        optimalW = Math.min(optimalW, iraBal);
        const wLtc = Math.max(0, optDynamicShortfall - optimalW);

        // === NAIVE 50/50 PATH (parallel simulation) ===
        const naiveRmd = calculateRMD(yp.year, naiveIraBal);
        const naiveLtcAvailable = naiveLtcBal + (yp.ltcPayout || 0);

        const naiveMagi2Prior = naiveMagiHistory.length >= 2
            ? naiveMagiHistory[naiveMagiHistory.length - 2]
            : (yp.magi2YearsPrior || 0);

        // === NAIVE 50/50 COMPUTATION ===
        // When no LTC available, naive and optimizer are identical strategies
        // (both take 100% from IRA). Use optimizer values directly to avoid
        // tax feedback loop divergence from different initial estimates.
        let naiveFromIra, naiveFromLtc, naiveTax;
        if (naiveLtcAvailable <= 0) {
            naiveFromIra = optimalW;
            naiveFromLtc = 0;
            naiveTax = optTax;
        } else {
            // Naive: estimate 50/50 on base shortfall, then compute dynamic
            naiveFromIra = Math.min(naiveIraBal, Math.max(naiveRmd, yp.shortfall * 0.5));
            const naiveTaxEst = calculateTaxCost(yp.year, naiveFromIra, {
                socialSecurity: yp.socialSecurity,
                rentalIncome: yp.rentalIncome || 0,
                medicalExpenses: yp.medicalExpenses || 0,
                mortgageInterest: yp.mortgageInterest || 0,
                propertyTax: yp.propertyTax || 0,
                charitableContributions: yp.charitableContributions || 0,
                magi2YearsPrior: naiveMagi2Prior
            });
            const naiveDynamicTax = naiveTaxEst.federalTax + naiveTaxEst.oregonTax + naiveTaxEst.irmaaSurcharge;
            const naiveDynamicExpenses = (yp.fixedExpensesNonTax || 0) + naiveDynamicTax
                + (yp.lifestyleExpense || 0) + (yp.charitableExpense || 0) + (yp.medicalExpenses || 0);
            const naiveDynamicShortfall = Math.max(0, naiveDynamicExpenses - (yp.externalIncome || 0));
            // Re-split 50/50 on dynamic shortfall
            naiveFromLtc = Math.min(naiveDynamicShortfall * 0.5, naiveLtcAvailable);
            naiveFromIra = naiveDynamicShortfall - naiveFromLtc;
            naiveFromIra = Math.max(naiveFromIra, naiveRmd);
            naiveFromIra = Math.min(naiveFromIra, naiveIraBal);
            if (naiveFromLtc + naiveFromIra < naiveDynamicShortfall) {
                naiveFromIra = Math.min(naiveIraBal, naiveDynamicShortfall - naiveFromLtc);
            }
            naiveFromLtc = Math.max(0, Math.min(naiveDynamicShortfall - naiveFromIra, naiveLtcAvailable));
        }

        // Compute naive tax (skip if already set from optimizer shortcut above)
        if (naiveLtcAvailable > 0) {
            naiveTax = calculateTaxCost(yp.year, naiveFromIra, {
                socialSecurity: yp.socialSecurity,
                rentalIncome: yp.rentalIncome || 0,
                medicalExpenses: yp.medicalExpenses || 0,
                mortgageInterest: yp.mortgageInterest || 0,
                propertyTax: yp.propertyTax || 0,
                charitableContributions: yp.charitableContributions || 0,
                magi2YearsPrior: naiveMagi2Prior
            });
        }

        lifetimeTax += optTax.totalCost;
        naiveLifetimeTax += naiveTax.totalCost;

        // Track MAGI for both paths
        magiHistory.push(optTax.magi);
        naiveMagiHistory.push(naiveTax.magi);

        // Bracket harvesting metadata
        const fwdSurvProb = survivalProbs[yp.year] || 0;
        // During wash, all IRA used (even to cover shortfall) is "harvesting" at low tax
        const harvestAmt = optTax.washActive ? Math.round(optimalW) : 0;
        const harvestActive = harvestAmt > 0 && optTax.washActive;

        decisions[yp.year] = {
            iraWithdrawal: Math.round(optimalW),
            ltcWithdrawal: Math.round(wLtc),
            marginalRate: optTax.marginalRate,
            irmaaHeadroom: optTax.irmaaHeadroom,
            washActive: optTax.washActive,
            rmdBinding: rmd > 0 && optimalW <= rmd * 1.01,
            taxSaved: naiveTax.totalCost - optTax.totalCost,
            naiveTax: naiveTax.totalCost,
            optimizedTax: optTax.totalCost,
            irmaaTier: optTax.irmaaTier,
            irmaaSurcharge: optTax.irmaaSurcharge,
            washLimit: optTax.washLimit,
            ssTier: optTax.ssTier,
            // Survival weighting
            survivalProb: Math.round(fwdSurvProb * 1000) / 1000,
            // Bracket harvesting
            harvestActive,
            harvestAmount: harvestActive ? harvestAmt : 0,
            harvestTaxCost: harvestActive ? optTax.totalCost : 0, // should be $0 during wash
            harvestNetBenefit: harvestActive
                ? Math.round(harvestAmt * cfg.heirsIrdRate * (1 - fwdSurvProb))
                : 0
        };

        // Transition both paths
        ltcBal = ltcAvailable - wLtc;
        iraBal = (iraBal - optimalW) * (1 + managedIraGrowth);
        naiveLtcBal = naiveLtcAvailable - naiveFromLtc;
        naiveIraBal = (naiveIraBal - naiveFromIra) * (1 + managedIraGrowth);
    }

    return {
        decisions,
        lifetimeTax: Math.round(lifetimeTax),
        naiveLifetimeTax: Math.round(naiveLifetimeTax),
        totalSaved: Math.round(naiveLifetimeTax - lifetimeTax),
        runtimeMs: Date.now() - startTime
    };
}

/**
 * Create a 2D grid initialized to a value.
 * @param {number} rows
 * @param {number} cols
 * @param {number} initVal
 * @returns {number[][]}
 */
function createGrid(rows, cols, initVal) {
    const grid = new Array(rows);
    for (let i = 0; i < rows; i++) {
        grid[i] = new Float64Array(cols).fill(initVal);
    }
    return grid;
}

/**
 * Round a value down to the nearest step.
 * @param {number} value
 * @param {number} step
 * @returns {number}
 */
function roundToStep(value, step) {
    return Math.floor(value / step) * step;
}

module.exports = { optimizeWithdrawalDP, toIndex, fromIndex, createGrid, roundToStep };
