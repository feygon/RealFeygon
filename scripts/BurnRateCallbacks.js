/**
 * @file BurnRate demo callbacks
 * @summary Database query callbacks for the public BurnRate planning demo
 * @description Handles database interactions for scenarios, parameters, and projections.
 */

// Import dependencies still used by methods kept in this file
const _calculateMedicalDeduction = require('./_calculateMedicalDeduction');
const _calculateSSDITaxability = require('./_calculateSSDITaxability');
const { PROJECTION_CONSTANTS, TAX_CONSTANTS } = require('./constants');
const { pow } = require('./deterministic-math');

module.exports = {

    /**
     * Get all scenarios from database
     */
    getScenarios: function(res, db, context, complete) {
        try {
            const stmt = db.prepare(`
                SELECT id, name, description, ltc_trigger_year,
                       condo_disposition, pool_start,
                       ira_growth, managed_ira_start, lifestyle_annual,
                       primary_appreciation, condo_appreciation,
                       memory_care_inflation, management_fee,
                       rental_income_monthly, heloc_rate,
                       medical_base_monthly, memory_care_cost,
                       total_mortgage_amount, mortgage_split_pct,
                       primary_mortgage_rate, condo_mortgage_rate,
                       condo_maintenance, condo_original_basis,
                       memory_care_year, year_of_passing,
                       sell_condo_upfront,
                       roommate_enabled, roommate_monthly,
                       primary_house_value, condo_value,
                       rental_increase_rate
                FROM scenario
                ORDER BY name
            `);
            context.scenarios = stmt.all();
            complete();
        } catch (err) {
            console.error('Error fetching scenarios:', err);
            res.status(500).send('Error loading scenarios: ' + err.message);
        }
    },

    /**
     * Get scenario detail including parameters and projections
     */
    getScenarioDetail: function(res, db, context, scenarioId, complete) {
        try {
            // Get scenario basic info
            const scenarioStmt = db.prepare(`SELECT * FROM scenario WHERE id = ?`);
            context.scenario = scenarioStmt.get(scenarioId);

            if (!context.scenario) {
                return res.status(404).send('Scenario not found');
            }

            // Get scenario parameters (simple + period-based)
            const paramStmt = db.prepare(`
                SELECT
                    sp.parameter_name, sp.parameter_type, sp.unit, sp.description, sp.has_periods,
                    spp.id as period_id, spp.period_name, spp.value,
                    spp.min_value, spp.max_value, spp.step_size,
                    spp.start_event_id, spp.end_event_id
                FROM scenario_parameter sp
                LEFT JOIN scenario_parameter_period spp
                    ON sp.scenario_id = spp.scenario_id
                    AND sp.parameter_name = spp.parameter_name
                WHERE sp.scenario_id = ?
                ORDER BY sp.parameter_name, spp.period_name
            `);
            const rawParams = paramStmt.all(scenarioId);

            // Group parameters by name
            context.parameters = {};
            rawParams.forEach(row => {
                if (!context.parameters[row.parameter_name]) {
                    context.parameters[row.parameter_name] = {
                        name: row.parameter_name,
                        type: row.parameter_type,
                        unit: row.unit,
                        description: row.description,
                        has_periods: row.has_periods,
                        periods: []
                    };
                }
                if (row.period_id) {
                    context.parameters[row.parameter_name].periods.push({
                        id: row.period_id,
                        name: row.period_name,
                        value: row.value,
                        min: row.min_value,
                        max: row.max_value,
                        step: row.step_size
                    });
                }
            });

            // Get financial instruments (annuity schedule for debug sidebar)
            context.instruments = db.prepare('SELECT id, type, monthly_payment, payment_end_date, flows_into_account, face_value, drop_dead_total FROM financial_instrument ORDER BY id').all();

            // Get LTC policy (for debug sidebar)
            context.ltcPolicy = db.prepare('SELECT * FROM insurance_policy_ltc WHERE insured_id = ?').get('A') || null;

            // Calculate projections for this scenario
            module.exports.getProjections(res, db, scenarioId, function(projectionResult) {
                context.projections = projectionResult.success ? projectionResult.years : [];
                context.outcome = projectionResult.success ? projectionResult.outcome : null;
                context.annotations = projectionResult.success ? projectionResult.annotations : null;
                context.optimizer = projectionResult.success ? (projectionResult.optimizer || null) : null;
                const { calculateMetrics } = require('./_calculateMetrics');
                context.metrics = calculateMetrics(context.projections);
                complete();
            });
        } catch (err) {
            console.error('Error fetching scenario detail:', err);
            res.status(500).send('Error loading scenario: ' + err.message);
        }
    },

    /**
     * Update a parameter value and recalculate projections
     */
    updateParameter: function(res, db, scenarioId, paramName, newValue, periodId, complete) {
        try {
            if (periodId) {
                const stmt = db.prepare(`
                    UPDATE scenario_parameter_period
                    SET value = ?
                    WHERE id = ? AND scenario_id = ?
                `);
                stmt.run(newValue, periodId, scenarioId);
            }

            // Recalculate projections after parameter update
            module.exports.getProjections(res, db, scenarioId, function(projectionResult) {
                complete({
                    success: true,
                    projections: projectionResult.success ? projectionResult.years : []
                });
            });
        } catch (err) {
            console.error('Error updating parameter:', err);
            complete({ success: false, error: err.message });
        }
    },

    /**
     * Get projection data for a scenario
     */
    getProjections: function(res, db, scenarioId, complete) {
        try {
            const { calculateProjection } = require('./_projectionEngine');
            const result = calculateProjection(db, scenarioId, module.exports);
            complete(result);
        } catch (err) {
            console.error('Error calculating projections:', err);
            complete({ success: false, error: err.message });
        }
    },

    /**
     * Load shared reference data for multiple projection runs in a single request.
     */
    getProjectionReferenceData: function(db) {
        const { loadProjectionReferenceData } = require('./_projectionEngine');
        return loadProjectionReferenceData(db);
    },


    // _evaluateRealEstateLiquidation DELETED — dead code.
    // Logic reimplemented in _decideWithdrawalStrategy.js (lines 140-263).
    // Tests rewritten in real-estate-liquidation.test.js to test that module directly.


    /**
     * Calculate outcome summary from projection years
     */
    _calculateOutcome: require('./_calculateResults').calculateOutcome,

    // _calculateOutcome_LEGACY DELETED — replaced by _calculateResults.calculateOutcome

    /**
     * Calculate instrument payment for a given year
     * Re-export shim for backward compatibility (delegates to _calculateYearIncome)
     */
    _calculateInstrumentPayment: function(instrument, year) {
        return require('./_calculateYearIncome').calculateInstrumentPayment(instrument, year);
    },

    /**
     * Calculate RMD for a given year
     */
    _calculateRMD: function(accounts, year, rateSet) {
        return require('./_calculateRMD').calculateRMDFromAccounts(accounts, year, rateSet);
    },

    /**
     * Calculate LTC payout for a given year
     * Re-export shim for backward compatibility (delegates to _calculateYearIncome)
     */
    _calculateLTCPayout: function(policy, triggerYear, year) {
        return require('./_calculateYearIncome').calculateLTCPayout(policy, triggerYear, year);
    },

    /**
     * Calculate expense for a given year with inflation
     */
    _calculateExpense: function(expense, year, startYear) {
        if (!expense) return 0;

        const baseAmount = expense.annual_amount || 0;
        const inflationRate = expense.inflation_rate || 0;
        const yearsElapsed = year - startYear;

        return baseAmount * pow(1 + inflationRate, yearsElapsed);
    },

    /**
     * Estimate taxes through iterative solving of circular dependency
     *
     * FINANCIAL CONCEPT: IRA withdrawals increase AGI, which increases taxes,
     * which requires more IRA withdrawals. This function solves by iteration.
     *
     * CIRCULAR DEPENDENCY:
     * 1. AGI depends on IRA distributions (IRA withdrawals are taxable income)
     * 2. Taxes depend on AGI (higher AGI = higher tax bracket)
     * 3. IRA distributions depend on taxes (need to withdraw enough to pay taxes)
     *
     * SOLUTION: Two-pass estimation
     * - Pass 1: Estimate IRA need based on income gap, calculate initial taxes
     * - Pass 2: Refine with actual IRA distributions after funding decisions
     *
     * @param {Object} params
     * @returns {Object} Tax estimation result with convergence info
     *
     * DECISION POINT: Shows how IRA withdrawal amount affects tax burden
     */
    _estimateTaxesIteratively: function(params) {
        const {
            personalBudget,
            ssdAmount,
            rentalIncome,
            deductionContext,
            year
        } = params;

        // Step 1: Estimate IRA distributions needed to cover budget gap
        let estimatedIRA = Math.max(0, personalBudget - ssdAmount);

        // Step 2: Calculate SSDI taxability tier based on provisional income
        const otherIncome = rentalIncome + estimatedIRA;
        const ssdiResult = _calculateSSDITaxability(ssdAmount, otherIncome, 0);

        // Step 3: Initial AGI estimate (taxable SS + rental + IRA)
        let estimatedAGI = ssdiResult.taxableSS + rentalIncome + estimatedIRA;

        // Step 3: Calculate itemized deductions based on estimated AGI
        const deductionInfo = this._calculateItemizedDeductions(
            estimatedAGI,
            deductionContext.expenses,
            deductionContext.memoryCareAmount,
            deductionContext.ltcTriggered,
            deductionContext.inMemoryCare,
            deductionContext.scenario,
            deductionContext.condoValue,
            deductionContext.hasRentalIncome,
            year,
            deductionContext.isMAPT || false
        );

        // Step 4: Calculate federal tax
        const federalTax = this._calculateFederalTax(estimatedAGI, year, deductionInfo.amount);

        // Step 5: Calculate Oregon state tax
        const oregonResult = this._calculateOregonTax(estimatedAGI, year, deductionInfo);
        const oregonTax = oregonResult.tax;

        const totalTax = federalTax + oregonTax;

        return {
            federalTax,
            oregonTax,
            totalTax,
            estimatedIRA,
            estimatedAGI,
            iterations: 1,
            convergence: 'Initial estimate',
            deductionInfo,
            oregonDeduction: oregonResult.oregonDeduction,
            oregonDeductionType: oregonResult.oregonDeductionType
        };
    },

    /**
     * Refine tax calculation with actual IRA distributions
     *
     * @param {Object} params
     * @returns {Object} Refined tax calculation
     */
    _refineTaxCalculation: function(params) {
        const {
            actualIraDistributions,
            ssdAmount,
            rentalIncome,
            deductionContext,
            year
        } = params;

        // Calculate SSDI taxability based on actual income
        const otherIncome = rentalIncome + actualIraDistributions;
        const ssdiResult = _calculateSSDITaxability(ssdAmount, otherIncome, 0);

        const actualAGI = ssdiResult.taxableSS + rentalIncome + actualIraDistributions;

        const deductionInfo = this._calculateItemizedDeductions(
            actualAGI,
            deductionContext.expenses,
            deductionContext.memoryCareAmount,
            deductionContext.ltcTriggered,
            deductionContext.inMemoryCare,
            deductionContext.scenario,
            deductionContext.condoValue,
            deductionContext.hasRentalIncome,
            year,
            deductionContext.isMAPT || false
        );

        const federalTax = this._calculateFederalTax(actualAGI, year, deductionInfo.amount);
        const oregonResult = this._calculateOregonTax(actualAGI, year, deductionInfo);
        const oregonTax = oregonResult.tax;

        const totalTax = federalTax + oregonTax;

        return {
            federalTax,
            oregonTax,
            totalTax,
            estimatedIRA: actualIraDistributions,
            estimatedAGI: actualAGI,
            iterations: 2,
            convergence: 'Converged',
            deductionInfo,
            oregonDeduction: oregonResult.oregonDeduction,
            oregonDeductionType: oregonResult.oregonDeductionType
        };
    },

    /**
     * Calculate federal income tax using 2025 brackets (single filer, age 65+)
     * Re-export shim — adapts (agi, year, deduction) to extracted module's (agi, deduction, year)
     */
    _calculateFederalTax: function(agi, year, deduction) {
        return require('./_calculateTaxes').calculateFederalTax(agi, deduction, year);
    },

    /**
     * Calculate Oregon state income tax using 2025 brackets (single filer)
     * Re-export shim — adapts (agi, year, deductionInfo) to extracted module's (agi, federalItemizedTotal, year)
     */
    _calculateOregonTax: function(agi, year, deductionInfo) {
        const federalItemizedTotal = deductionInfo.itemized_breakdown.itemized_total;
        return require('./_calculateTaxes').calculateOregonTax(agi, federalItemizedTotal, year);
    },

    /**
     * Calculate itemized deductions and compare to standard deduction
     * Returns the greater of standard or itemized, plus breakdown info
     */
    _calculateItemizedDeductions: function(agi, expenses, memoryCareAmount, ltcTriggered, inMemoryCare, scenario, condoValue, hasRentalIncome, year, isMAPTScenario) {
        const STANDARD_DEDUCTION = TAX_CONSTANTS.federal.standardDeduction2026;
        const SALT_CAP = TAX_CONSTANTS.federal.saltCap;

        // Calculate medical expenses and deduction using extracted function
        const medicalResult = _calculateMedicalDeduction(agi, memoryCareAmount, ltcTriggered, inMemoryCare, scenario, year);
        const { medicalExpenses, medicalThreshold, deductibleMedical, medicalTier, nursingTier } = medicalResult;

        // === SCHEDULE A: Personal itemized deductions ===

        // MAPT: property taxes, mortgage interest, depreciation all belong to the trust's return
        // Person A only gets medical deductions on Schedule A
        let scheduleAPropertyTaxes = 0;
        let mortgageInterest = 0;

        if (!isMAPTScenario) {
            // Property taxes (SALT capped at $10,000)
            // If rental: only primary home taxes on Sch A; condo taxes go to Sch E
            // If not rental: both primary + condo taxes on Sch A (personal property)
            scheduleAPropertyTaxes = expenses.primary_house_taxes || 0;
            if (!hasRentalIncome) {
                scheduleAPropertyTaxes += (expenses.condo_property_tax || 0);
            }

            // Mortgage interest (fully deductible, no cap).
            // LEDGER-REFACTOR Bug4: SNT condo mortgage interest is dead money —
            // not deductible to Person A, MAPT, or SNT. Only primary IO interest
            // qualifies as Person A's Schedule A qualified-residence interest.
            // See: docs/ledger-refactor/rationale-digest.md §H
            // See: openspec/audits/Owner-Corrections-Session-2.md:7
            mortgageInterest = (expenses.primary_mortgage_interest || 0);
        }

        const deductiblePropertyTax = Math.min(SALT_CAP, scheduleAPropertyTaxes);

        // Charitable contributions (pre-MC only, no inflation)
        const charitableDeduction = expenses.charitable || 0;

        // Schedule A total
        const scheduleATotal = deductibleMedical + deductiblePropertyTax + mortgageInterest + charitableDeduction;

        // === SCHEDULE E: Rental property deductions ===
        // Only applies when condo is being rented AND not in MAPT (trust files its own return)

        let depreciation = 0;
        let rentalExpenses = 0;

        if (hasRentalIncome && !isMAPTScenario) {
            // Rental property depreciation (residential: 27.5 years)
            // IRS requires depreciation on original cost basis, not current market value
            if (condoValue > 0) {
                const buildingValue = (scenario.condo_original_basis || condoValue) * 0.8;  // 80% building, 20% land
                depreciation = buildingValue / 27.5;     // Residential rental: 27.5 year schedule
            }

            // Rental condo expenses (deductible against rental income on Sch E)
            rentalExpenses = (expenses.condo_property_tax || 0) +
                             (expenses.management_fee || 0) +
                             (expenses.condo_hoa || 0) +
                             (expenses.condo_maintenance || 0) +
                             (expenses.condo_insurance || 0) +
                             (expenses.condo_deferred_maintenance || 0);
        }

        // Schedule E total
        const scheduleETotal = depreciation + rentalExpenses;

        // Combined itemized total
        const itemizedTotal = scheduleATotal + scheduleETotal;

        // Compare to standard deduction and use greater
        const useItemized = itemizedTotal > STANDARD_DEDUCTION;
        const deductionAmount = useItemized ? itemizedTotal : STANDARD_DEDUCTION;

        return {
            amount: deductionAmount,
            type: useItemized ? 'itemized' : 'standard',
            medical_expenses: medicalExpenses,
            nursing_tier: nursingTier,
            itemized_breakdown: {
                medical_total: medicalExpenses,
                medical_threshold: medicalThreshold,
                medical_deductible: deductibleMedical,
                property_tax_total: scheduleAPropertyTaxes,
                property_tax_deductible: deductiblePropertyTax,
                mortgage_interest: mortgageInterest,
                primary_mortgage_interest: expenses.primary_mortgage_interest || 0,
                condo_mortgage_interest: expenses.condo_mortgage_interest || 0,
                depreciation: depreciation,
                rental_expenses: rentalExpenses,
                condo_value: condoValue,
                charitable: charitableDeduction,
                schedule_a_total: scheduleATotal,
                schedule_e_total: scheduleETotal,
                itemized_total: itemizedTotal,
                standard_deduction: STANDARD_DEDUCTION
            }
        };
    },

    /**
     * Calculate memory care expense
     * Inflates from base year (configured in PROJECTION_CONSTANTS), not from start year
     */
    _calculateMemoryCare: function(scenario, year, rateSet, startYear) {
        const baseCost = scenario.memory_care_cost || 120000;
        const inflationRate = scenario.memory_care_inflation || rateSet?.memory_care_inflation || 0.05;
        const baseYear = PROJECTION_CONSTANTS.baseYear;

        if (!startYear || year < startYear) return 0;

        // Inflate from base year, not start year
        const yearsFromBase = year - baseYear;
        return baseCost * pow(1 + inflationRate, yearsFromBase);
    },

    // _calculateMetrics: extracted to _calculateMetrics.js (Step 10)
    _calculateMetrics: function(projections) {
        return require('./_calculateMetrics').calculateMetrics(projections);
    },
    /**
     * Calculate financial changes when transitioning to memory care
     *
     * FINANCIAL CONCEPT: Memory care changes spending structure
     * - Lifestyle drops to $0 (all discretionary spending stops)
     * - Memory care facility cost ~$8k/month ($96k/year) inflating at 5%
     * - Primary house and rental property costs CONTINUE
     * - Personal budget shows ongoing obligations, not lifestyle
     *
     * @param {number} year - Current projection year
     * @param {number} memoryCareStartYear - Year facility starts (null if never)
     * @param {Object} scenario - Scenario configuration
     * @param {Object} rateSet - Rate configuration
     * @param {number} lifestyleAnnual - Pre-memory-care lifestyle amount from slider
     * @returns {Object} Memory care transition state and amounts
     *
     * DECISION POINT: When should memory care start? (offset slider controls this)
     * COST VISIBILITY: Shows that house/rental costs don't stop during facility stay
     *
     * FAMILY QUESTION ANSWERED:
     * "What changes financially when memory care starts?"
     * ANSWER: Lifestyle goes to $0, but property costs continue. Memory care
     *         facility cost (~$96k-$150k/year inflated) becomes the major expense.
     */
    _applyMemoryCareTransition: function(year, memoryCareStartYear, scenario, rateSet, lifestyleAnnual) {
        // Determine if currently in memory care
        const inMemoryCare = memoryCareStartYear && year >= memoryCareStartYear;

        // Calculate memory care expense (if applicable)
        let memoryCareExpense = 0;
        if (inMemoryCare) {
            memoryCareExpense = this._calculateMemoryCare(scenario, year, rateSet, memoryCareStartYear);
        }

        // Calculate gross expense target (personal budget)
        // During memory care: $0 (no discretionary spending)
        // Before memory care: slider value (e.g., $95k)
        const grossExpenseTarget = inMemoryCare ? 0 : (lifestyleAnnual || 0);

        // Build explanation for decision transparency
        let explanation = '';
        if (inMemoryCare) {
            explanation = `In memory care (year ${year - memoryCareStartYear + 1}): ` +
                `lifestyle=$0, facility cost=$${Math.round(memoryCareExpense).toLocaleString()}/year. ` +
                `Property expenses continue unchanged.`;
        } else if (memoryCareStartYear) {
            const yearsUntil = memoryCareStartYear - year;
            explanation = `${yearsUntil} year${yearsUntil !== 1 ? 's' : ''} until memory care. ` +
                `Current lifestyle budget: $${Math.round(lifestyleAnnual || 0).toLocaleString()}/year.`;
        } else {
            explanation = `No memory care projected. Lifestyle budget: $${Math.round(lifestyleAnnual || 0).toLocaleString()}/year.`;
        }

        return {
            inMemoryCare,
            grossExpenseTarget,
            memoryCareExpense,
            explanation
        };
    }
};
