/**
 * Integration tests for the public BurnRate demo route family.
 * These run against a temporary copy of the demo SQLite DB so tests do not
 * mutate the working demo database.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const Database = require('../../scripts/sqlite-database');

describe('BurnRate Route Integration Tests', () => {
    let app;
    let db;
    let tempDir;
    let tempDbPath;

    before(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'burnrate-demo-route-'));
        tempDbPath = path.join(tempDir, 'burnrate_demo.test.db');

        fs.copyFileSync(
            path.join(__dirname, '../../burnrate_data/burnrate_demo.db'),
            tempDbPath
        );

        db = new Database(tempDbPath);

        app = express();
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
    });

    after(() => {
        if (db) {
            db.close();
        }
        if (tempDbPath && fs.existsSync(tempDbPath)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('renders the BurnRate overview without Nickerson route leaks', (done) => {
        request(app)
            .get('/BurnRate/')
            .expect(200)
            .expect('Content-Type', /html/)
            .expect((res) => {
                expect(res.text).to.include('BurnRate Financial Planning');
                expect(res.text).to.include('/BurnRate/scenario/ScA_Baseline');
                expect(res.text).to.not.include('/Nickerson/');
                expect(res.text).to.not.include('/logout');
            })
            .end(done);
    });

    it('renders the BurnRate scenario detail with BurnRate-specific assets', (done) => {
        request(app)
            .get('/BurnRate/scenario/ScA_MAPT')
            .expect(200)
            .expect('Content-Type', /html/)
            .expect((res) => {
                expect(res.text).to.include('Scenario A: Asset Protection');
                expect(res.text).to.include('/static/js/burnrate-param-sidebar.js');
                expect(res.text).to.not.include('/Nickerson/');
                expect(res.text).to.not.include('/logout');
            })
            .end(done);
    });

    it('returns metrics for the requested BurnRate scenarios', (done) => {
        request(app)
            .post('/BurnRate/scenarios/metrics')
            .send({ scenarioIds: ['ScA_Baseline', 'ScA_NoTrust', 'ScA_MAPT'] })
            .expect(200)
            .expect('Content-Type', /json/)
            .expect((res) => {
                expect(res.body.success).to.equal(true);
                expect(res.body.metrics).to.have.property('ScA_Baseline');
                expect(res.body.metrics).to.have.property('ScA_NoTrust');
                expect(res.body.metrics).to.have.property('ScA_MAPT');
            })
            .end(done);
    });

    it('updates a BurnRate parameter against the demo DB copy', (done) => {
        request(app)
            .post('/BurnRate/scenario/ScA_MAPT/update-parameter')
            .send({ paramName: 'optimizer_enabled', paramValue: 1 })
            .expect(200)
            .expect('Content-Type', /json/)
            .expect((res) => {
                expect(res.body.success).to.equal(true);
                expect(res.body.metrics).to.be.an('object');
                const current = db.prepare('SELECT optimizer_enabled FROM scenario WHERE id = ?').get('ScA_MAPT');
                expect(current.optimizer_enabled).to.equal(1);
            })
            .end(done);
    });

    it('does not overwrite a stored LTC trigger year when rendering the overview', (done) => {
        db.prepare('UPDATE scenario SET ltc_trigger_year = ? WHERE id = ?').run(2031, 'ScA_Baseline');
        db.prepare('UPDATE scenario SET ltc_trigger_year = ? WHERE id = ?').run(2031, 'ScA_NoTrust');
        db.prepare('UPDATE scenario SET ltc_trigger_year = ? WHERE id = ?').run(2031, 'ScA_MAPT');

        request(app)
            .get('/BurnRate/')
            .expect(200)
            .expect((res) => {
                expect(res.text).to.include('BurnRate Financial Planning');

                const current = db.prepare(
                    'SELECT id, ltc_trigger_year FROM scenario WHERE id IN (?, ?, ?) ORDER BY id'
                ).all('ScA_Baseline', 'ScA_MAPT', 'ScA_NoTrust');

                current.forEach((row) => {
                    expect(row.ltc_trigger_year).to.equal(2031);
                });
            })
            .end(done);
    });
});
