/**
 * Shared sqlite adapter (scripts/sqlite-database.js).
 * Source of truth is BurnRate-Private; its full behaviour suite lives there
 * (tests/sqlite-database.test.js). This file checks the copy and the basics.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('../../scripts/sqlite-database');

const root = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'shared-files.json'), 'utf8'));

describe('shared files (scripts/shared-files.json)', () => {
    Object.entries(manifest.files).forEach(([file, expected]) => {
        it(file + ' matches the manifest hash', () => {
            const source = fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
            expect(crypto.createHash('sha256').update(source).digest('hex')).to.equal(expected);
        });
    });
});

describe('sqlite adapter', () => {
    it('selects node:sqlite on Node 24+ and better-sqlite3 otherwise', () => {
        const major = Number(process.versions.node.split('.')[0]);
        expect(Database.backend).to.equal(major >= 24 ? 'node:sqlite' : 'better-sqlite3');
    });

    it('reads, writes and rolls back like better-sqlite3', () => {
        const db = new Database(':memory:');
        db.exec('CREATE TABLE t (a INTEGER)');
        db.prepare('INSERT INTO t VALUES (?)').run(1);
        const failing = db.transaction(() => {
            db.prepare('INSERT INTO t VALUES (?)').run(2);
            throw new Error('boom');
        });
        expect(() => failing()).to.throw('boom');
        expect(db.prepare('SELECT a FROM t').all()).to.deep.equal([{ a: 1 }]);
        expect(db.pragma('foreign_keys', { simple: true })).to.equal(1);
        db.close();
        expect(db.open).to.equal(false);
    });
});
