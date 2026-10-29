'use strict';

// Source of truth: BurnRate-Private/scripts/sqlite-database.js.
// RealFeygon/scripts/sqlite-database.js must stay byte-identical (checked by
// both test suites and by scripts/deploy.sh).
//
// better-sqlite3-compatible wrapper over node:sqlite (Node 24+). Falls back to
// better-sqlite3 on older runtimes. See docs/development/NODE24-SQLITE-ADAPTER-PRD.md.

const fs = require('fs');

const BUSY_TIMEOUT_MS = 5000;
const MULTI_STATEMENT_MESSAGE = 'The supplied SQL string contains more than one statement';
const BIND_TYPE_MESSAGE = 'SQLite3 can only bind numbers, strings, bigints, buffers, and null';

function loadNodeSqlite() {
    if (process.env.SQLITE_BACKEND === 'better-sqlite3') {
        return null;
    }
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 24) {
        return null;
    }
    try {
        return require('node:sqlite');
    } catch (err) {
        return null;
    }
}

function toPlainRow(row) {
    return row === undefined ? undefined : Object.assign({}, row);
}

function normalizeBindValue(value) {
    if (value === undefined) {
        return null;
    }
    if (typeof value === 'boolean') {
        throw new TypeError(BIND_TYPE_MESSAGE);
    }
    return value;
}

function normalizeBindArgs(args) {
    const flat = [];
    args.forEach((arg) => {
        if (Array.isArray(arg)) {
            arg.forEach((value) => flat.push(normalizeBindValue(value)));
        } else if (arg !== null && typeof arg === 'object' && !Buffer.isBuffer(arg) && !ArrayBuffer.isView(arg)) {
            const named = {};
            Object.keys(arg).forEach((key) => { named[key] = normalizeBindValue(arg[key]); });
            flat.push(named);
        } else {
            flat.push(normalizeBindValue(arg));
        }
    });
    return flat;
}

// Strips whitespace, stray semicolons and comments; anything left is a second statement.
function hasTrailingStatement(tail) {
    let rest = tail;
    for (;;) {
        rest = rest.replace(/^[\s;]+/, '');
        if (rest.startsWith('--')) {
            const newline = rest.indexOf('\n');
            rest = newline === -1 ? '' : rest.slice(newline + 1);
        } else if (rest.startsWith('/*')) {
            const end = rest.indexOf('*/');
            rest = end === -1 ? '' : rest.slice(end + 2);
        } else {
            return rest.length > 0;
        }
    }
}

class Statement {
    constructor(database, native, source) {
        this.database = database;
        this.source = source;
        this.native = native;
    }

    run(...args) {
        this.database.trace(this.source);
        const result = this.native.run(...normalizeBindArgs(args));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    }

    get(...args) {
        this.database.trace(this.source);
        return toPlainRow(this.native.get(...normalizeBindArgs(args)));
    }

    all(...args) {
        this.database.trace(this.source);
        return this.native.all(...normalizeBindArgs(args)).map(toPlainRow);
    }
}

function createNodeSqliteDatabase(nodeSqlite) {
    class Database {
        constructor(filename, options) {
            const opts = options || {};
            const file = filename === undefined || filename === '' ? ':memory:' : filename;
            this.name = file;
            this.memory = file === ':memory:';
            this.readonly = Boolean(opts.readonly);
            if (opts.fileMustExist && !this.memory && !fs.existsSync(file)) {
                const err = new Error('unable to open database file');
                err.code = 'SQLITE_CANTOPEN';
                throw err;
            }
            this.native = new nodeSqlite.DatabaseSync(file, {
                readOnly: this.readonly,
                timeout: opts.timeout === undefined ? BUSY_TIMEOUT_MS : opts.timeout,
                enableForeignKeyConstraints: true
            });
            this.verbose = typeof opts.verbose === 'function' ? opts.verbose : null;
            this.savepointCount = 0;
        }

        get open() {
            return this.native.isOpen;
        }

        get inTransaction() {
            return this.native.isOpen && this.native.isTransaction;
        }

        trace(sql) {
            if (this.verbose) {
                this.verbose(sql);
            }
        }

        prepare(sql) {
            const native = this.native.prepare(sql);
            const consumed = native.sourceSQL;
            const start = sql.indexOf(consumed);
            const tail = start === -1 ? '' : sql.slice(start + consumed.length);
            if (hasTrailingStatement(tail)) {
                throw new RangeError(MULTI_STATEMENT_MESSAGE);
            }
            return new Statement(this, native, sql);
        }

        exec(sql) {
            this.trace(sql);
            this.native.exec(sql);
            return this;
        }

        pragma(source, options) {
            const rows = this.prepare('PRAGMA ' + source).all();
            if (options && options.simple) {
                return rows.length === 0 ? undefined : Object.values(rows[0])[0];
            }
            return rows;
        }

        transaction(fn) {
            const database = this;
            return function runTransaction(...args) {
                const nested = database.inTransaction;
                const savepoint = nested ? '"adapter_sp_' + (++database.savepointCount) + '"' : null;
                database.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN');
                let result;
                try {
                    result = fn.apply(this, args);
                    database.exec(nested ? 'RELEASE ' + savepoint : 'COMMIT');
                } catch (err) {
                    if (database.inTransaction) {
                        try {
                            database.exec(nested ? 'ROLLBACK TO ' + savepoint + '; RELEASE ' + savepoint : 'ROLLBACK');
                        } catch (rollbackErr) {
                            // Keep the original error; a failed rollback must not mask it.
                        }
                    }
                    throw err;
                }
                return result;
            };
        }

        close() {
            if (this.native.isOpen) {
                this.native.close();
            }
            return this;
        }
    }
    Database.backend = 'node:sqlite';
    return Database;
}

function createFallbackDatabase() {
    const BetterSqlite3 = require('better-sqlite3');
    class Database extends BetterSqlite3 {}
    Database.backend = 'better-sqlite3';
    return Database;
}

const nodeSqlite = loadNodeSqlite();

module.exports = nodeSqlite ? createNodeSqliteDatabase(nodeSqlite) : createFallbackDatabase();
