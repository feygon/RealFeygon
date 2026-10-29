/**
 * @file Projection Engine
 * @summary Year-by-year financial projection calculator
 * @description Extracted from NickersonCallbacks.getProjections (Step 1 of refactor).
 *
 * This module contains the full projection calculation logic. It receives a
 * `callbacks` context object to call helper methods that still live on the
 * NickersonCallbacks module (these will be extracted to their own modules in
 * subsequent refactoring steps).
 *
 * See openspec/plans/NickersonCallbacks-Refactor.md for ordering rationale.
 */

// Import modules used directly by the orchestrator
const { _decideWithdrawalStrategy } = require('./_decideWithdrawalStrategy');
const { calculatePropertyValue } = require('./_calculatePropertyValue');
const { calculateYearExpenses } = require('./_calculateYearExpenses');
const { PROJECTION_CONSTANTS } = require('./constants');
const { calculateBalanceUpdates } = require('./_calculateBalanceUpdates');
const { taxEstimate, taxActual } = require('./_calculateTaxPass');
const { optimizeWithdrawalDP } = require('./_optimizeWithdrawalDP');
const { validateQ1Q2Funding } = require('./_validateQ1Q2Funding');
const { pow } = require('./deterministic-math');

/**
 * Load scenario configuration and all activated entities from the database.
 *
 * @param {Object} db - Database connection (or mock)
 * @param {string} scenarioId - Scenario ID to load
 * @returns {Object|null} { scenario, rateSet, accounts, instruments, properties, incomeSources, expenses, ltcPolicy } or null if not found
 */
function loadProjectionReferenceData(db) {
    const rateSets = db.prepare('SELECT * FROM rate_set').all();
    const rateSetsById = new Map(rateSets.map(rateSet => [rateSet.id, rateSet]));

    return {
        rateSetsById,
        accounts: db.prepare('SELECT * FROM account').all(),
        instruments: db.prepare('SELECT * FROM financial_instrument').all(),
        properties: db.prepare('SELECT * FROM real_estate_property').all(),
        incomeSources: db.prepare('SELECT * FROM income_source').all(),
        expenses: db.prepare('SELECT * FROM expense').all(),
        ltcPolicy: db.prepare('SELECT * FROM insurance_policy_ltc WHERE insured_id = ?').get('A')
    };
}

function _loadScenarioData(db, scenarioId, referenceData) {
    const scenario = db.prepare('SELECT * FROM scenario WHERE id = ?').get(scenarioId);
    if (!scenario) return null;

    const rateSetId = scenario.rate_set_id || 'baseline';
    const rateSet = referenceData?.rateSetsById?.get(rateSetId)
        || db.prepare('SELECT * FROM rate_set WHERE id = ?').get(rateSetId);

    // Get activated entities for this scenario
    const activatedEntities = db.prepare(`
        SELECT entity_type, entity_id
        FROM scenario_entity_activation
        WHERE scenario_id = ? AND is_active = 1
    `).all(scenarioId);

    // Build activation sets for quick lookup
    const activeAccounts = new Set();
    const activeInstruments = new Set();
    const activeProperties = new Set();
    const activeIncomes = new Set();
    const activeExpenses = new Set();

    activatedEntities.forEach(ae => {
        switch (ae.entity_type) {
            case 'account': activeAccounts.add(ae.entity_id); break;
            case 'financial_instrument': activeInstruments.add(ae.entity_id); break;
            case 'real_estate_property': activeProperties.add(ae.entity_id); break;
            case 'income_source': activeIncomes.add(ae.entity_id); break;
            case 'expense': activeExpenses.add(ae.entity_id); break;
        }
    });

    return {
        scenario,
        rateSet,
        accounts: (referenceData?.accounts || db.prepare('SELECT * FROM account').all()).filter(a => activeAccounts.has(a.id)),
        instruments: (referenceData?.instruments || db.prepare('SELECT * FROM financial_instrument').all()).filter(i => activeInstruments.has(i.id)),
        properties: (referenceData?.properties || db.prepare('SELECT * FROM real_estate_property').all()).filter(p => activeProperties.has(p.id)),
        incomeSources: (referenceData?.incomeSources || db.prepare('SELECT * FROM income_source').all()).filter(i => activeIncomes.has(i.id)),
        expenses: (referenceData?.expenses || db.prepare('SELECT * FROM expense').all()).filter(e => activeExpenses.has(e.id)),
        ltcPolicy: referenceData?.ltcPolicy || db.prepare('SELECT * FROM insurance_policy_ltc WHERE insured_id = ?').get('A')
    };
}

/**
 * Calculate cashflow for a single projection year: income, expenses, trust ops,
 * lifestyle floor, tax estimate, and shortfall.
 *
 * @param {Object} ctx - Year context with all balances, scenario data, and yearData
 * @param {Object} callbacks - NickersonCallbacks module
 * @returns {Object} Cashflow results including yearData mutations and updated balances
 */
function calculateYearCashflow(ctx, callbacks) {
    const {
        year, startYear, yearData, scenario, rateSet, incomeSources, instruments, ltcPolicy,
        isMAPT, isNonGrantor, isGrantor, medicaidActive, medicaidTriggerYear, condoSold, inMemoryCare,
        expenses, hasRentalIncome: hasRentalIncomeParam, annualRentalIncome: annualRentalIncomeParam,
        primaryMortgageBalance, primaryMortgageRate,
        condoMortgageBalance, condoMortgageRate, condoMortgageMonthlyPayment,
        memoryCareStartYear, helocBalance, helocRate, condoValue
    } = ctx;
    let { trustBalance, sntBalance, sdiraCheckingBalance, ltcSavingsBalance } = ctx;

    // Step 4: Calculate income
    const { calculateYearIncome } = require('./_calculateYearIncome');
    const incomeResult = calculateYearIncome({
        year, scenario, incomeSources, instruments, ltcPolicy,
        isMAPT, isNonGrantor, isGrantor,
        medicaidActive, medicaidTriggerYear, condoSold, inMemoryCare
    });
    let ssdAmount = incomeResult.ssdAmount;
    let annualRentalIncome = incomeResult.annualRentalIncome;
    let hasRentalIncome = incomeResult.hasRentalIncome;
    const annuityPayments = incomeResult.annuityPayments;
    const roommateIncome = incomeResult.roommateIncome;
    const roommateDepreciation = incomeResult.roommateDepreciation;
    Object.assign(yearData.income, incomeResult.income);
    Object.assign(yearData, incomeResult.yearData);
    // Apply balance deltas
    if (incomeResult.deltaBalances.sdiraCheckingBalance) sdiraCheckingBalance += incomeResult.deltaBalances.sdiraCheckingBalance;
    if (incomeResult.deltaBalances.trustBalance) trustBalance += incomeResult.deltaBalances.trustBalance;
    if (incomeResult.deltaBalances.ltcSavingsBalance) ltcSavingsBalance += incomeResult.deltaBalances.ltcSavingsBalance;
    yearData.sdira_checking_available = sdiraCheckingBalance;

    // Expense calculations (non-tax)
    const expenseResult = calculateYearExpenses({
        year, startYear, expenses, scenario, rateSet,
        isMAPT, inMemoryCare, medicaidActive, medicaidTriggerYear,
        condoSold, hasRentalIncome, annualRentalIncome,
        primaryMortgageBalance, primaryMortgageRate,
        condoMortgageBalance, condoMortgageRate, condoMortgageMonthlyPayment,
        memoryCareStartYear,
        helocBalance, helocRate,
        trustBalance, sntBalance
    });
    let fixedExpenses = expenseResult.fixedExpenses;
    let maptPropertyExpenses = expenseResult.maptPropertyExpenses;
    let memoryCareAmount = expenseResult.memoryCareAmount;
    const totalMortgageInterest = expenseResult.totalMortgageInterest;
    Object.assign(yearData.expenses, expenseResult.expenses);
    Object.assign(yearData, expenseResult.yearData);
    // Apply mortgage balance sets
    const newPrimaryMortgageBalance = expenseResult.setBalances.primaryMortgageBalance;
    const newCondoMortgageBalance = expenseResult.setBalances.condoMortgageBalance;
    const newMortgageBalance = expenseResult.setBalances.mortgageBalance;
    // Apply delta balances
    if (expenseResult.deltaBalances.sntBalance) sntBalance += expenseResult.deltaBalances.sntBalance;
    if (expenseResult.deltaBalances.trustBalance) trustBalance += expenseResult.deltaBalances.trustBalance;

    // Step 6: MAPT trust operations
    if (isMAPT) {
        const { calculateTrustOperations } = require('./_calculateTrustOperations');
        const trustResult = calculateTrustOperations({
            annualRentalIncome, roommateIncome, roommateDepreciation,
            condoValue, scenario, yearExpenses: yearData.expenses, inMemoryCare,
            isGrantor, medicaidActive,
            year, condoSold,
            trustBalance, sntBalance,
        });
        Object.assign(yearData, trustResult.yearData);
        if (trustResult.deltaBalances.trustBalance) trustBalance += trustResult.deltaBalances.trustBalance;
        if (trustResult.deltaBalances.sntBalance) sntBalance += trustResult.deltaBalances.sntBalance;
    }

    // Step 7b: Lifestyle floor
    const baseLifestyleFloor = (scenario.lifestyle_floor_monthly || 2500) * 12;
    const mcMaintenanceAnnual = (scenario.mc_maintenance_monthly || 300) * 12;
    const mcResidualAnnual = (scenario.mc_residual_monthly || 200) * 12;
    const ltcTriggerYr = scenario.ltc_trigger_year || 2028;
    const mcYear = scenario.memory_care_year || 2032;
    const intensifyYear = ltcTriggerYr + Math.floor((mcYear - ltcTriggerYr) / 2);
    const ltcTriggeredForLifestyle = ltcPolicy && ltcTriggerYr && year >= ltcTriggerYr;

    let lifestyleExpense = 0;
    if (inMemoryCare) {
        lifestyleExpense = (mcMaintenanceAnnual + mcResidualAnnual) * pow(1.05, year - startYear);
    } else if (ltcTriggeredForLifestyle && year >= intensifyYear) {
        const yearsSinceIntensify = year - intensifyYear;
        const reduction = Math.min(0.20, yearsSinceIntensify * 0.10);
        lifestyleExpense = baseLifestyleFloor * pow(1.05, year - startYear) * (1 - reduction);
    } else {
        lifestyleExpense = baseLifestyleFloor * pow(1.05, year - startYear);
    }
    lifestyleExpense = Math.round(lifestyleExpense);
    yearData.expenses.lifestyle = lifestyleExpense;

    // Charitable giving: pre-MC only, no inflation, tax-deductible
    const charitableAnnual = inMemoryCare ? 0 : (scenario.charitable_monthly || 0) * 12;
    yearData.expenses.charitable = charitableAnnual;

    const GROSS_EXPENSE_TARGET = inMemoryCare ? lifestyleExpense : (fixedExpenses + lifestyleExpense + charitableAnnual + 15000);

    // Step 7a: Tax estimate
    const taxEst = taxEstimate({
        ssdAmount, GROSS_EXPENSE_TARGET, isMAPT, isNonGrantor, yearData,
        ltcPolicy, scenario, year, memoryCareAmount,
        inMemoryCare, condoValue, hasRentalIncome, callbacks
    });
    const { rentalForTax, ltcTriggered, deductionInfo, estimatedAGI } = taxEst;
    let { federalTax, oregonTax } = taxEst;
    const totalTax = taxEst.totalTax;

    const estimatedMedicalExpenses = deductionInfo.medical_expenses;
    const estimatedMedicalOutflow = inMemoryCare ? 0 : estimatedMedicalExpenses;
    let totalExpenses = fixedExpenses + totalTax + lifestyleExpense + charitableAnnual + estimatedMedicalOutflow;

    // Calculate shortfall
    let externalIncome = ssdAmount + (isMAPT ? 0 : (yearData.income.rental || 0));
    const shortfall = totalExpenses - externalIncome;

    return {
        sdiraCheckingBalance, ltcSavingsBalance, trustBalance, sntBalance,
        primaryMortgageBalance: newPrimaryMortgageBalance,
        condoMortgageBalance: newCondoMortgageBalance,
        mortgageBalance: newMortgageBalance,
        ssdAmount, hasRentalIncome, annualRentalIncome,
        fixedExpenses, maptPropertyExpenses, memoryCareAmount,
        lifestyleExpense, GROSS_EXPENSE_TARGET,
        rentalForTax, ltcTriggered, deductionInfo, estimatedAGI,
        federalTax, oregonTax, totalTax, totalExpenses,
        externalIncome, shortfall
    };
}

/**
 * Execute withdrawal strategy and RMD enforcement for a single year.
 *
 * @param {Object} ctx - Context with balances, shortfall, scenario data
 * @param {Object} callbacks - NickersonCallbacks module
 * @returns {Object} Withdrawal results including updated balances and yearData mutations
 */
function executeYearWithdrawals(ctx, callbacks) {
    const {
        year, yearData, scenario, shortfall, estimatedAGI,
        isMAPT, medicaidActive, accounts, rateSet,
        sdiraCheckingBalance: sdiraIn, managedIraBalance: managedIn,
        ltcSavingsBalance: ltcIn, helocBalance: helocIn,
        helocMaxLtv, houseValue, mortgageBalance: mortIn,
        primaryMortgageBalance: primaryIn, condoMortgageBalance: condoMortIn,
        condoValue: condoIn, condoSold: condoSoldIn, externalIncome: extIncomeIn,
        optimizerHint
    } = ctx;

    let sdiraCheckingBalance = sdiraIn;
    let managedIraBalance = managedIn;
    let ltcSavingsBalance = ltcIn;
    let helocBalance = helocIn;
    let mortgageBalance = mortIn;
    let primaryMortgageBalance = primaryIn;
    let condoMortgageBalance = condoMortIn;
    let condoValue = condoIn;
    let condoSold = condoSoldIn;
    let condoSaleYear = null;
    let externalIncome = extIncomeIn;

    let iraDistributions = 0;
    let ltcSpending = 0;
    let fromSdiraChecking = 0;
    let fromManagedIra = 0;

    // H1 pre-fund: if SDIRA is low and LS6 hasn't matured, transfer from ManagedIRA
    // to ensure Q1-Q2 expenses can be covered from SDIRA before LS6 arrives in June
    const LS6_MATURITY_YEAR = 2036;
    if (!medicaidActive && year <= LS6_MATURITY_YEAR && sdiraCheckingBalance < shortfall * 0.5 && managedIraBalance > 0) {
        const h1Need = shortfall * 0.5; // 50% of annual = H1
        const prefundAmount = Math.min(h1Need - sdiraCheckingBalance, managedIraBalance);
        if (prefundAmount > 0) {
            sdiraCheckingBalance += prefundAmount;
            managedIraBalance -= prefundAmount;
            yearData.h1_prefund_transfer = prefundAmount;
        }
    }

    if (medicaidActive) {
        yearData.medicaid_active = true;
        yearData.strategy = 'medicaid — trust funded';
    } else {
        const withdrawalDecision = _decideWithdrawalStrategy(shortfall, {
            ltcSavings: ltcSavingsBalance,
            sdiraChecking: sdiraCheckingBalance,
            managedIRA: managedIraBalance,
            helocBalance: helocBalance,
            helocMaxLtv: helocMaxLtv,
            houseValue: houseValue,
            mortgageBalance: mortgageBalance,
            primaryMortgageBalance: primaryMortgageBalance,
            condoMortgageBalance: condoMortgageBalance,
            condoValue: condoValue,
            condoSold: condoSold,
            condoDisposition: scenario.condo_disposition
        }, year, estimatedAGI, optimizerHint);

        iraDistributions = withdrawalDecision.fromSDIRA + withdrawalDecision.fromManagedIRA;
        ltcSpending = withdrawalDecision.fromLTC;
        fromSdiraChecking = withdrawalDecision.fromSDIRA;
        fromManagedIra = withdrawalDecision.fromManagedIRA;

        // Enforce RMD for age >= 73
        const rmd = callbacks._calculateRMD(accounts, year, rateSet);
        if (rmd > iraDistributions) {
            const additionalRmd = rmd - iraDistributions;
            const sdiraAvailable = withdrawalDecision.newSdiraBalance;
            const managedIraAvailable = withdrawalDecision.newManagedIraBalance;

            if (sdiraAvailable >= additionalRmd) {
                fromSdiraChecking += additionalRmd;
                withdrawalDecision.newSdiraBalance -= additionalRmd;
            } else {
                fromSdiraChecking += sdiraAvailable;
                withdrawalDecision.newSdiraBalance = 0;
                const remainingRmd = additionalRmd - sdiraAvailable;
                fromManagedIra += Math.min(remainingRmd, managedIraAvailable);
                withdrawalDecision.newManagedIraBalance -= Math.min(remainingRmd, managedIraAvailable);
            }

            iraDistributions = rmd;
            yearData.rmd_enforced = true;
            yearData.rmd_amount = rmd;
        }

        // Apply balance changes
        ltcSavingsBalance = withdrawalDecision.newLtcBalance;
        sdiraCheckingBalance = withdrawalDecision.newSdiraBalance;
        managedIraBalance = withdrawalDecision.newManagedIraBalance;
        helocBalance = withdrawalDecision.newHelocBalance;
        mortgageBalance = withdrawalDecision.newMortgageBalance;
        primaryMortgageBalance = withdrawalDecision.newPrimaryMortgageBalance;
        condoMortgageBalance = withdrawalDecision.newCondoMortgageBalance;
        condoValue = withdrawalDecision.newCondoValue;

        // Handle condo sale
        if (withdrawalDecision.condoSoldThisYear) {
            condoSold = true;
            condoSaleYear = year;
            yearData.condo_sold = true;
            yearData.condo_sale_proceeds = withdrawalDecision.condoProceeds;
            if (withdrawalDecision.helocPayoff > 0) {
                yearData.heloc_payoff = withdrawalDecision.helocPayoff;
            }
            if (withdrawalDecision.mortgagePaydown > 0) {
                yearData.mortgage_paydown_from_sale = withdrawalDecision.mortgagePaydown;
            }
        }

        // Handle HELOC draw
        if (withdrawalDecision.fromHELOC > 0) {
            yearData.heloc_drawn = withdrawalDecision.fromHELOC;
        }

        // Handle notes and warnings
        if (withdrawalDecision.note) yearData.note = withdrawalDecision.note;
        if (withdrawalDecision.warning) yearData.warning = withdrawalDecision.warning;
        if (withdrawalDecision.realEstateLiquidationNeeded > 0) {
            yearData.real_estate_liquidation_needed = withdrawalDecision.realEstateLiquidationNeeded;
        }
    }

    // Record income/cashflow from asset spending
    if (iraDistributions > 0) {
        yearData.income.ira_distributions = iraDistributions;
        externalIncome += iraDistributions;
    }
    if (ltcSpending > 0) {
        yearData.income.ltc_spending = ltcSpending;
        externalIncome += ltcSpending;
    }

    return {
        sdiraCheckingBalance, managedIraBalance, ltcSavingsBalance,
        helocBalance, mortgageBalance, primaryMortgageBalance,
        condoMortgageBalance, condoValue, condoSold, condoSaleYear,
        iraDistributions, ltcSpending, fromSdiraChecking, fromManagedIra,
        externalIncome
    };
}

/**
 * Finalize year: recalculate actual taxes, update balances, Medicaid look-ahead, push to ledger.
 *
 * @param {Object} ctx - Context with all year state
 * @param {Object} callbacks - NickersonCallbacks module
 * @returns {Object} Updated balances for next year iteration
 */
function finalizeYear(ctx, callbacks) {
    const {
        year, yearData, scenario, rateSet, years, isMAPT, isNonGrantor,
        ssdAmount, iraDistributions, rentalForTax, ltcTriggered,
        memoryCareAmount, inMemoryCare, condoValue, hasRentalIncome,
        fixedExpenses, lifestyleExpense, GROSS_EXPENSE_TARGET,
        fromSdiraChecking, fromManagedIra,
        managedIraBalance: managedIn, sdiraCheckingBalance: sdiraIn,
        ltcSavingsBalance: ltcIn, ltcSpending,
        primaryMortgageBalance, condoMortgageBalance, mortgageBalance,
        trustBalance, sntBalance, lookbackClearYear,
        externalIncome, maptPropertyExpenses, ledger,
        medicaidActive: medicaidActiveIn, medicaidTriggerYear: medicaidTriggerIn,
        shortfall
    } = ctx;

    let managedIraBalance = managedIn;
    let medicaidTriggerYear = medicaidTriggerIn;

    // Step 4: Recalculate actual AGI and taxes
    const taxAct = taxActual({
        ssdAmount, iraDistributions, rentalForTax, isMAPT, isNonGrantor, yearData,
        ltcTriggered, scenario, year, memoryCareAmount,
        inMemoryCare, condoValue, hasRentalIncome,
        fixedExpenses, lifestyleExpense, years, callbacks
    });
    const federalTax = taxAct.federalTax;
    const oregonTax = taxAct.oregonTax;
    const irmaaSurcharge = taxAct.irmaaSurcharge;
    const totalExpenses = taxAct.totalExpenses;

    // Store SS taxability for tooltip display
    yearData.taxable_ss = taxAct.taxable_ss;
    yearData.ss_tier = taxAct.ss_tier;
    yearData.provisional_income = taxAct.provisional_income;
    yearData.ss_taxable_fraction = taxAct.ss_taxable_fraction;

    // Balance updates, IRA growth, and cumulative ledger
    const balanceResult = calculateBalanceUpdates({
        yearData, fromSdiraChecking, fromManagedIra,
        managedIraBalance, sdiraCheckingBalance: sdiraIn, ltcSavingsBalance: ltcIn,
        ltcSpending, primaryMortgageBalance, condoMortgageBalance,
        mortgageBalance, isMAPT, trustBalance, sntBalance,
        year, lookbackClearYear, externalIncome, GROSS_EXPENSE_TARGET,
        inMemoryCare, totalExpenses, lifestyleExpense,
        scenario, rateSet, maptPropertyExpenses, ledger
    });
    managedIraBalance = balanceResult.managedIraBalance;

    // Step 11: Medicaid look-ahead
    const { medicaidLookAhead } = require('./_medicaidTransition');
    const lookAheadResult = medicaidLookAhead({
        isMAPT, medicaidActive: medicaidActiveIn, medicaidTriggerYear, inMemoryCare,
        sdiraCheckingBalance: sdiraIn, managedIraBalance, ltcSavingsBalance: ltcIn,
        shortfall, year, memoryCareYear: scenario.memory_care_year
    });
    if (lookAheadResult) {
        medicaidTriggerYear = lookAheadResult.medicaidTriggerYear;
        yearData.medicaid_pre_liquidation = lookAheadResult.preLiquidation;
    }

    return { managedIraBalance, medicaidTriggerYear };
}

/**
 * Process a single projection year: cashflow, withdrawals, finalization.
 *
 * @param {Object} s - Mutable state object carrying all balances across years
 * @param {number} year - The year to process
 * @param {Object} data - Scenario data (scenario, rateSet, accounts, instruments, etc.)
 * @param {Object} callbacks - NickersonCallbacks module
 */
function processYear(s, year, data, callbacks) {
    const { scenario, rateSet, accounts, instruments, incomeSources, expenses, ltcPolicy, properties } = data;

    const yearData = {
        year: year,
        age_a: PROJECTION_CONSTANTS.baseYearAgeA + (year - PROJECTION_CONSTANTS.baseYear),
        income: {},
        expenses: {},
        assets: {},
        liabilities: {}
    };

    // Opening balances
    yearData.sdira_checking_open = s.sdiraCheckingBalance;
    yearData.managed_ira_open = s.managedIraBalance;
    yearData.total_ira_open = s.sdiraCheckingBalance + s.managedIraBalance;
    yearData.ltc_savings_open = s.ltcSavingsBalance;
    if (s.isMAPT) {
        yearData.mapt_checking_open = s.trustBalance;
        yearData.snt_balance_open = s.sntBalance;
    }

    // Medicaid transition (MAPT only)
    if (s.isMAPT && !s.medicaidActive && s.medicaidTriggerYear && year === s.medicaidTriggerYear) {
        const { executeMedicaidTransition } = require('./_medicaidTransition');
        const mtResult = executeMedicaidTransition({
            year, sdiraCheckingBalance: s.sdiraCheckingBalance, managedIraBalance: s.managedIraBalance,
            ltcSavingsBalance: s.ltcSavingsBalance,
            condoMortgageBalance: s.condoMortgageBalance, primaryMortgageBalance: s.primaryMortgageBalance,
            instruments, incomeSources, scenario, rateSet, years: s.years,
            calculateMemoryCare: callbacks._calculateMemoryCare.bind(callbacks)
        });
        s.sdiraCheckingBalance = mtResult.setBalances.sdiraCheckingBalance;
        s.managedIraBalance = mtResult.setBalances.managedIraBalance;
        s.ltcSavingsBalance = mtResult.setBalances.ltcSavingsBalance;
        s.condoMortgageBalance = mtResult.setBalances.condoMortgageBalance;
        s.mortgageBalance = mtResult.setBalances.mortgageBalance;
        s.medicaidActive = mtResult.setBalances.medicaidActive;
        s.sntBalance += mtResult.deltaBalances.sntBalance;
        Object.assign(yearData, mtResult.yearData);
    }

    // Real estate
    yearData.house_value = s.houseValue;
    yearData.condo_value = s.condoValue;
    if (year === s.startYear && s.sellUpfront && s.upfrontSaleProceeds > 0) {
        yearData.condo_sold = true;
        yearData.condo_sale_proceeds = s.upfrontSaleProceeds;
        yearData.condo_sale_type = 'upfront';
    }
    yearData.heloc_balance = s.helocBalance;
    yearData.heloc_rate = s.helocRate;
    yearData.mortgage_balance = s.mortgageBalance;
    yearData.primary_mortgage_balance = s.primaryMortgageBalance;
    yearData.primary_mortgage_rate = s.primaryMortgageRate;
    yearData.condo_mortgage_balance = s.condoMortgageBalance;
    yearData.condo_mortgage_rate = s.condoMortgageRate;

    // Property appreciation — house appreciates always, condo appreciates only if not sold this year
    // Condo sale happens at START of year (pre-appreciation) to fund that year's expenses
    const houseAppreciationRate = scenario.primary_appreciation || rateSet?.primary_house_appreciation || 0.06;
    const condoAppreciationRate = scenario.condo_appreciation || rateSet?.condo_appreciation || 0.05;
    const condoValueBeforeAppreciation = s.condoValue; // Save for sale price if sold this year
    const propertyCalc = calculatePropertyValue({
        houseValue: s.houseValue, condoValue: s.condoValue,
        houseAppreciationRate, condoAppreciationRate, condoSold: s.condoSold
    });
    yearData.house_appreciation = propertyCalc.house_appreciation;
    yearData.condo_appreciation = propertyCalc.condo_appreciation;
    yearData.total_appreciation = propertyCalc.total_appreciation;
    yearData.real_estate_total = propertyCalc.real_estate_total;
    s.houseValue = propertyCalc.new_house_value;
    s.condoValue = propertyCalc.new_condo_value;
    // Store pre-appreciation value for withdrawal strategy (condo sold at BOY value)
    s.condoValuePreAppreciation = condoValueBeforeAppreciation;

    const memoryCareStartYear = scenario.memory_care_year || null;
    const inMemoryCare = memoryCareStartYear && year >= memoryCareStartYear;

    // --- Cashflow: income, expenses, trust, lifestyle, tax estimate, shortfall ---
    const cashflow = calculateYearCashflow({
        year, startYear: s.startYear, yearData, scenario, rateSet,
        incomeSources, instruments, ltcPolicy,
        isMAPT: s.isMAPT, isNonGrantor: s.isNonGrantor, isGrantor: s.isGrantor,
        medicaidActive: s.medicaidActive,
        medicaidTriggerYear: s.medicaidTriggerYear, condoSold: s.condoSold,
        inMemoryCare, expenses,
        hasRentalIncome: s.hasRentalIncome, annualRentalIncome: 0,
        primaryMortgageBalance: s.primaryMortgageBalance, primaryMortgageRate: s.primaryMortgageRate,
        condoMortgageBalance: s.condoMortgageBalance, condoMortgageRate: s.condoMortgageRate,
        condoMortgageMonthlyPayment: s.condoMortgageMonthlyPayment,
        memoryCareStartYear, helocBalance: s.helocBalance, helocRate: s.helocRate,
        condoValue: s.condoValue,
        trustBalance: s.trustBalance, sntBalance: s.sntBalance,
        sdiraCheckingBalance: s.sdiraCheckingBalance, ltcSavingsBalance: s.ltcSavingsBalance
    }, callbacks);

    // Update balances from cashflow
    s.sdiraCheckingBalance = cashflow.sdiraCheckingBalance;
    s.ltcSavingsBalance = cashflow.ltcSavingsBalance;
    s.trustBalance = cashflow.trustBalance;
    s.sntBalance = cashflow.sntBalance;
    s.primaryMortgageBalance = cashflow.primaryMortgageBalance;
    s.condoMortgageBalance = cashflow.condoMortgageBalance;
    s.mortgageBalance = cashflow.mortgageBalance;

    // --- Withdrawals: strategy + RMD ---
    const optimizerHint = s.optimizerDecisions ? s.optimizerDecisions[year] : null;
    const withdrawals = executeYearWithdrawals({
        year, yearData, scenario, shortfall: cashflow.shortfall,
        estimatedAGI: cashflow.estimatedAGI,
        isMAPT: s.isMAPT, medicaidActive: s.medicaidActive,
        accounts, rateSet,
        sdiraCheckingBalance: s.sdiraCheckingBalance, managedIraBalance: s.managedIraBalance,
        ltcSavingsBalance: s.ltcSavingsBalance, helocBalance: s.helocBalance,
        helocMaxLtv: s.helocMaxLtv, houseValue: s.houseValue,
        mortgageBalance: s.mortgageBalance,
        primaryMortgageBalance: s.primaryMortgageBalance,
        condoMortgageBalance: s.condoMortgageBalance,
        condoValue: s.condoValuePreAppreciation || s.condoValue, condoSold: s.condoSold,
        externalIncome: cashflow.externalIncome,
        optimizerHint
    }, callbacks);

    // Update balances from withdrawals
    s.sdiraCheckingBalance = withdrawals.sdiraCheckingBalance;
    s.managedIraBalance = withdrawals.managedIraBalance;
    s.ltcSavingsBalance = withdrawals.ltcSavingsBalance;
    s.helocBalance = withdrawals.helocBalance;
    s.mortgageBalance = withdrawals.mortgageBalance;
    s.primaryMortgageBalance = withdrawals.primaryMortgageBalance;
    s.condoMortgageBalance = withdrawals.condoMortgageBalance;
    s.condoValue = withdrawals.condoValue;
    if (withdrawals.condoSold) {
        s.condoSold = true;
        if (withdrawals.condoSaleYear) s.condoSaleYear = withdrawals.condoSaleYear;
        // Revert condo appreciation — sold at BOY before appreciation
        s.condoValue = 0;
        yearData.condo_appreciation = 0;
        yearData.total_appreciation = yearData.house_appreciation;
        yearData.real_estate_total = s.houseValue;
    }

    // Capital gains tax on condo sale (non-MAPT only — MAPT gets stepped-up basis via LPOA)
    if (yearData.condo_sold && yearData.condo_sale_proceeds > 0) {
        const { calculateCapitalGainsTax } = require('./_calculateCapitalGains');
        const condoBasis = scenario.condo_original_basis || scenario.condo_value || 400000;
        const otherIncome = (yearData.income.ssdi || 0) + (yearData.income.ira_distributions || 0);
        const cgTax = calculateCapitalGainsTax(yearData.condo_sale_proceeds, condoBasis, s.isMAPT, otherIncome);
        yearData.capital_gains = cgTax;
        if (cgTax.totalTax > 0) {
            yearData.expenses.capital_gains_tax = cgTax.totalTax;
        }
    }

    // Store optimizer metadata on yearData
    if (optimizerHint) {
        yearData.optimizer = {
            iraWithdrawal: optimizerHint.iraWithdrawal,
            ltcWithdrawal: optimizerHint.ltcWithdrawal,
            marginalRate: optimizerHint.marginalRate,
            irmaaHeadroom: optimizerHint.irmaaHeadroom,
            washActive: optimizerHint.washActive,
            rmdBinding: optimizerHint.rmdBinding,
            taxSaved: optimizerHint.taxSaved,
            naiveTax: optimizerHint.naiveTax,
            optimizedTax: optimizerHint.optimizedTax,
            irmaaTier: optimizerHint.irmaaTier,
            ssTier: optimizerHint.ssTier
        };
    }

    // --- Finalize: actual tax, balance updates, Medicaid look-ahead ---
    const finalized = finalizeYear({
        year, yearData, scenario, rateSet, years: s.years, isMAPT: s.isMAPT, isNonGrantor: s.isNonGrantor,
        ssdAmount: cashflow.ssdAmount,
        iraDistributions: withdrawals.iraDistributions,
        rentalForTax: cashflow.rentalForTax, ltcTriggered: cashflow.ltcTriggered,
        memoryCareAmount: cashflow.memoryCareAmount, inMemoryCare,
        condoValue: s.condoValue, hasRentalIncome: cashflow.hasRentalIncome,
        fixedExpenses: cashflow.fixedExpenses, lifestyleExpense: cashflow.lifestyleExpense,
        GROSS_EXPENSE_TARGET: cashflow.GROSS_EXPENSE_TARGET,
        fromSdiraChecking: withdrawals.fromSdiraChecking, fromManagedIra: withdrawals.fromManagedIra,
        managedIraBalance: s.managedIraBalance, sdiraCheckingBalance: s.sdiraCheckingBalance,
        ltcSavingsBalance: s.ltcSavingsBalance, ltcSpending: withdrawals.ltcSpending,
        primaryMortgageBalance: s.primaryMortgageBalance,
        condoMortgageBalance: s.condoMortgageBalance,
        mortgageBalance: s.mortgageBalance,
        trustBalance: s.trustBalance, sntBalance: s.sntBalance,
        lookbackClearYear: s.lookbackClearYear,
        externalIncome: withdrawals.externalIncome,
        maptPropertyExpenses: cashflow.maptPropertyExpenses, ledger: s.ledger,
        medicaidActive: s.medicaidActive, medicaidTriggerYear: s.medicaidTriggerYear,
        shortfall: cashflow.shortfall
    }, callbacks);

    s.managedIraBalance = finalized.managedIraBalance;
    s.medicaidTriggerYear = finalized.medicaidTriggerYear;

    s.years.push(yearData);
}

/**
 * Calculate projections for a scenario.
 *
 * @param {Object} db - Database connection (or mock)
 * @param {string} scenarioId - Scenario ID to calculate
 * @param {Object} callbacks - NickersonCallbacks module (for this._method() calls during transition)
 * @returns {Object} { success, years, outcome, annotations, error }
 */
function calculateProjection(db, scenarioId, callbacks, options) {
    const referenceData = options?.referenceData || null;
    const data = _loadScenarioData(db, scenarioId, referenceData);
    if (!data) {
        return { success: false, error: 'Scenario not found' };
    }

    const { scenario, rateSet, accounts, instruments, properties, incomeSources, expenses, ltcPolicy } = data;

    // Initialize scenario state
    const { initializeScenario } = require('./_initializeScenario');
    const state = initializeScenario(scenario, accounts, properties, rateSet);

    // Build mutable state object for the year loop
    let s = { ...state };

    // Two-pass optimizer: first run without optimizer to get real shortfall/medical/etc,
    // then run optimizer with accurate params, then re-run projection with optimizer decisions.
    let optimizerDecisions = null;
    if (scenario.optimizer_enabled) {
        // Pass 1: run projection without optimizer to extract real year params
        s.optimizerDecisions = null;
        for (let year = s.startYear; year <= s.endYear; year++) {
            processYear(s, year, data, callbacks);
        }

        // Extract accurate yearParams from pass 1 results
        const startLtc = state.ltcSavingsBalance || 0;
        const startIra = (state.sdiraCheckingBalance || 0) + (state.managedIraBalance || 0);
        const iraGrowth = scenario.managed_ira_growth_rate || rateSet?.ira_growth_rate || 0.04;
        const isMAPT = scenario.condo_disposition === 'trust_mapt';

        const LS6_YEAR = 2036;
        const LS6_AMOUNT = 65000;
        const LS7_YEAR = 2028;
        const LS7_AMOUNT = 25018;

        // Only optimize pre-Medicaid years — post-Medicaid is covered by Medicaid
        const medicaidYear = s.years.find(y => y.medicaid_invoked || y.medicaid_active);
        const lastOptYear = medicaidYear ? medicaidYear.year - 1 : s.endYear;

        const yearParams = s.years
            .filter(y => y.year <= lastOptYear)
            .map(y => {
                const externalIncome = (y.income.ssdi || 0) + (isMAPT ? 0 : (y.income.rental || 0));
                // Non-tax fixed expenses (everything except tax, lifestyle, medical, charitable, IRMAA)
                const nonTaxExpenses = (y.expenses.total || 0)
                    - (y.expenses.federal_income_tax || 0)
                    - (y.expenses.oregon_income_tax || 0)
                    - (y.expenses.irmaa || 0)
                    - (y.expenses.lifestyle || 0)
                    - (y.expenses.charitable || 0)
                    - (y.expenses.medical || 0)
                    - (y.expenses.memory_care || 0);
                return {
                    year: y.year,
                    shortfall: Math.max(0, (y.expenses.total || 0) - externalIncome),
                    // Components for dynamic shortfall computation in DP
                    fixedExpensesNonTax: Math.max(0, nonTaxExpenses),
                    lifestyleExpense: y.expenses.lifestyle || 0,
                    charitableExpense: y.expenses.charitable || 0,
                    externalIncome,
                    socialSecurity: y.income.ssdi || 0,
                    rentalIncome: isMAPT ? 0 : (y.income.rental || 0),
                    medicalExpenses: (y.expenses.medical || 0) + (y.expenses.memory_care || 0),
                    mortgageInterest: isMAPT ? 0 : ((y.expenses.primary_mortgage_interest || 0) + (y.expenses.condo_mortgage_interest || 0)),
                    propertyTax: isMAPT ? 0 : (y.expenses.primary_house_taxes || 0),
                    charitableContributions: y.expenses.charitable || 0,
                    ltcPayout: y.income.ltc_payout || 0,
                    magi2YearsPrior: y.irmaa_lookback_magi || 0,
                    h1LumpSum: y.year === LS7_YEAR ? LS7_AMOUNT : 0,
                    h2LumpSum: y.year === LS6_YEAR ? LS6_AMOUNT : 0,
                    ls6Available: y.year >= LS6_YEAR
                };
            });

        // Pass 2: run optimizer with accurate params
        const optimizerResult = optimizeWithdrawalDP(yearParams, startLtc, startIra, iraGrowth);
        optimizerDecisions = optimizerResult.decisions;

        // Reset state for pass 2: re-initialize from scratch
        const state2 = initializeScenario(scenario, accounts, properties, rateSet);
        s = { ...state2 };
        s.optimizerResult = optimizerResult;
        s.optimizerDecisions = optimizerDecisions;

        // Re-run projection with optimizer decisions
        for (let year = s.startYear; year <= s.endYear; year++) {
            processYear(s, year, data, callbacks);
        }
    } else {
        s.optimizerDecisions = null;
        // Single pass: no optimizer
        for (let year = s.startYear; year <= s.endYear; year++) {
            processYear(s, year, data, callbacks);
        }
    }

    // Post-loop results
    const { calculateOutcome, calculateAnnotations } = require('./_calculateResults');
    const outcome = calculateOutcome(s.years, scenario);
    const annotations = calculateAnnotations({
        years: s.years, scenario, ltcPolicy,
        condoSaleYear: s.condoSaleYear, isMAPT: s.isMAPT,
        trustFormationYear: s.trustFormationYear, lookbackClearYear: s.lookbackClearYear,
        medicaidTriggerYear: s.medicaidTriggerYear, endYear: s.endYear
    });

    const result = {
        success: true,
        years: s.years,
        outcome,
        annotations,
        scenario: {
            id: scenario.id,
            ltc_trigger_year: scenario.ltc_trigger_year,
            memory_care_year: scenario.memory_care_year,
            year_of_passing: scenario.year_of_passing
        }
    };
    if (s.optimizerResult) {
        const initState = initializeScenario(scenario, accounts, properties, rateSet);
        const q1q2 = validateQ1Q2Funding(
            s.optimizerResult, scenario,
            (initState.sdiraCheckingBalance || 0) + (initState.managedIraBalance || 0),
            initState.ltcSavingsBalance || 0,
            scenario.managed_ira_growth_rate || rateSet?.ira_growth_rate || 0.04
        );
        result.optimizer = {
            lifetimeTax: s.optimizerResult.lifetimeTax,
            naiveLifetimeTax: s.optimizerResult.naiveLifetimeTax,
            totalSaved: s.optimizerResult.totalSaved,
            runtimeMs: s.optimizerResult.runtimeMs,
            ...q1q2
        };
        // Propagate Q1/Q2 flags to relevant yearData
        if (q1q2.mc_early_medicaid_flag) {
            const flagYear = s.years.find(y => y.year === q1q2.mc_early_medicaid_flag);
            if (flagYear && flagYear.optimizer) {
                flagYear.optimizer.mc_early_medicaid_flag = q1q2.mc_early_medicaid_flag;
                flagYear.optimizer.mc_affordable_facility_warning = q1q2.mc_affordable_facility_warning;
            }
        }
    }
    return result;
}

module.exports = { calculateProjection, loadProjectionReferenceData };
