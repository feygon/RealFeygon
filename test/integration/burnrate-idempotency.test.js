/**
 * Idempotency tests for the public BurnRate demo routes.
 *
 * These tests intentionally seed distinct values into every adjustable
 * scenario field in a temporary copy of the demo DB, then verify repeated
 * read-oriented requests do not mutate persisted state.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const Database = require('../../scripts/sqlite-database');
const { ALLOWED_PARAMS } = require('../../BurnRate');

const SCENARIO_IDS = ['ScA_Baseline', 'ScA_NoTrust', 'ScA_MAPT'];
const TIMELINE_FIELDS = ['ltc_trigger_year', 'memory_care_year', 'year_of_passing'];
const BOOLEAN_LIKE_FIELDS = new Set(['sell_condo_upfront', 'roommate_enabled', 'optimizer_enabled']);
const DECIMAL_RATE_FIELDS = new Set([
    'ira_growth',
    'primary_appreciation',
    'condo_appreciation',
    'memory_care_inflation',
    'management_fee',
    'heloc_rate',
    'mortgage_split_pct',
    'primary_mortgage_rate',
    'condo_mortgage_rate',
    'rental_increase_rate'
]);
const TRACKED_FIELDS = [...new Set([...TIMELINE_FIELDS, ...ALLOWED_PARAMS])];

function buildApp(db) {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));

    const handlebars = require('express-handlebars').create({
        defaultLayout: null,
        helpers: require('../../views/helpers/helpers')
    });

    app.engine('handlebars', handlebars.engine);
    app.set('view engine', 'handlebars');
    app.set('views', path.join(__dirname, '../../views'));
    app.set('dbBurnRate', db);
    app.set('BurnRateCallbacks', require('../../scripts/BurnRateCallbacks'));
    app.use('/BurnRate', require('../../BurnRate'));

    return app;
}

function getTrackedFields(db) {
    const availableColumns = new Set(
        db.prepare('PRAGMA table_info(scenario)').all().map((row) => row.name)
    );
    return TRACKED_FIELDS.filter((field) => availableColumns.has(field));
}

function getSeededValue(field, currentValue, scenarioIndex, fieldIndex) {
    if (field === 'ltc_trigger_year') return 2028 + scenarioIndex;
    if (field === 'memory_care_year') return 2031 + scenarioIndex;
    if (field === 'year_of_passing') return 2039 + scenarioIndex;
    if (BOOLEAN_LIKE_FIELDS.has(field)) return (scenarioIndex + fieldIndex) % 2;

    const numericValue = typeof currentValue === 'number' ? currentValue : Number(currentValue);
    const base = Number.isFinite(numericValue) ? numericValue : 0;

    if (DECIMAL_RATE_FIELDS.has(field)) {
        return +(base + ((scenarioIndex + 1) * 0.004) + ((fieldIndex % 3) * 0.001)).toFixed(4);
    }

    return Math.round(base + ((scenarioIndex + 1) * (fieldIndex + 2) * 11));
}

function seedScenarioRows(db, trackedFields) {
    const updateSql = `UPDATE scenario SET ${trackedFields.map((field) => `${field} = @${field}`).join(', ')} WHERE id = @id`;
    const updateStmt = db.prepare(updateSql);

    const seed = db.transaction(() => {
        SCENARIO_IDS.forEach((scenarioId, scenarioIndex) => {
            const current = db.prepare('SELECT * FROM scenario WHERE id = ?').get(scenarioId);
            const next = { id: scenarioId };

            trackedFields.forEach((field, fieldIndex) => {
                next[field] = getSeededValue(field, current[field], scenarioIndex, fieldIndex);
            });

            updateStmt.run(next);
        });
    });

    seed();
}

function snapshotScenarioRows(db, trackedFields) {
    const selectSql = `SELECT id, ${trackedFields.join(', ')} FROM scenario WHERE id IN (${SCENARIO_IDS.map(() => '?').join(', ')}) ORDER BY id`;
    const rows = db.prepare(selectSql).all(...SCENARIO_IDS);
    return rows.map((row) => {
        const snapshot = { id: row.id };
        trackedFields.forEach((field) => {
            snapshot[field] = row[field];
        });
        return snapshot;
    });
}

describe('BurnRate Idempotency Integration Tests', () => {
    let app;
    let db;
    let tempDir;
    let tempDbPath;
    let trackedFields;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnrate-idempotency-'));
        tempDbPath = path.join(tempDir, 'burnrate_demo.idempotency.db');

        fs.copyFileSync(
            path.join(__dirname, '../../burnrate_data/burnrate_demo.db'),
            tempDbPath
        );

        db = new Database(tempDbPath);
        trackedFields = getTrackedFields(db);
        seedScenarioRows(db, trackedFields);
        app = buildApp(db);
    });

    afterEach(() => {
        if (db) {
            db.close();
        }
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('repeated overview loads do not mutate tracked scenario fields', async () => {
        const before = snapshotScenarioRows(db, trackedFields);

        await request(app).get('/BurnRate/').expect(200);
        await request(app).get('/BurnRate/').expect(200);

        const after = snapshotScenarioRows(db, trackedFields);
        expect(after).to.deep.equal(before);
    });

    it('repeated all-scenario metrics requests are idempotent and stable', async () => {
        const before = snapshotScenarioRows(db, trackedFields);

        const first = await request(app)
            .post('/BurnRate/scenarios/metrics')
            .send({ scenarioIds: SCENARIO_IDS })
            .expect(200);

        const second = await request(app)
            .post('/BurnRate/scenarios/metrics')
            .send({ scenarioIds: SCENARIO_IDS })
            .expect(200);

        const after = snapshotScenarioRows(db, trackedFields);

        expect(first.body.success).to.equal(true);
        expect(second.body.success).to.equal(true);
        expect(second.body.metrics).to.deep.equal(first.body.metrics);
        expect(after).to.deep.equal(before);
    });

    SCENARIO_IDS.forEach((scenarioId) => {
        it(`repeated metrics requests for ${scenarioId} do not mutate tracked scenario fields`, async () => {
            const before = snapshotScenarioRows(db, trackedFields);

            const first = await request(app)
                .post('/BurnRate/scenarios/metrics')
                .send({ scenarioIds: [scenarioId] })
                .expect(200);

            const second = await request(app)
                .post('/BurnRate/scenarios/metrics')
                .send({ scenarioIds: [scenarioId] })
                .expect(200);

            const after = snapshotScenarioRows(db, trackedFields);

            expect(first.body.success).to.equal(true);
            expect(second.body.success).to.equal(true);
            expect(first.body.metrics).to.have.property(scenarioId);
            expect(second.body.metrics).to.deep.equal(first.body.metrics);
            expect(after).to.deep.equal(before);
        });
    });
});
