/**
 * Database connection for the public BurnRate demo route.
 * Uses a separate local SQLite file so the demo route does not depend on a
 * private planner database path or runtime secret.
 */
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const Database = require('./scripts/sqlite-database');
const path = require('path');
const { cleanupStaleSqliteSidecars } = require('./scripts/sqlite-sidecar-cleanup');

const dbPath = process.env.BURNRATE_DB_PATH || path.join(__dirname, 'burnrate_data', 'burnrate_demo.db');

cleanupStaleSqliteSidecars(dbPath, {
    logger: process.env.NODE_ENV !== 'production' ? console : null
});

const db = new Database(dbPath, {
    verbose: process.env.NODE_ENV !== 'production' ? console.log : null,
    fileMustExist: true
});
console.error('[sqlite] backend=' + Database.backend + ' db=burnrate');

db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

module.exports = db;
