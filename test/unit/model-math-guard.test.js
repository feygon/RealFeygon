/**
 * Server-side model code must not use platform-dependent math (Math.pow, **, or
 * other libm-backed Math functions): Node 24 computes them differently than
 * Node 18/20 and differently on Windows vs Linux. The model uses
 * scripts/deterministic-math.js instead. Full rationale and the guard's
 * self-tests live in BurnRate-Private (tests/model-math-guard.test.js).
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const LIBM_CALL = /\bMath\.(pow|exp|expm1|log|log10|log2|log1p|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|cbrt|hypot)\b/;
const POW_OPERATOR = /\*\*=?/;

function stripCommentsAndStrings(source) {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, ' ');
}

const files = fs.readdirSync(path.join(root, 'scripts'))
    .filter((name) => /^_.*\.js$/.test(name) || /Callbacks\.js$/.test(name))
    .filter((name) => fs.existsSync(path.join(root, 'scripts', name)));

describe('platform-math guard', () => {
    it('finds model files to check', () => {
        expect(files.length).to.be.greaterThan(10);
    });

    files.forEach((name) => {
        it(name + ' uses no platform-dependent math', () => {
            const code = stripCommentsAndStrings(fs.readFileSync(path.join(root, 'scripts', name), 'utf8'));
            expect(LIBM_CALL.test(code), 'libm call').to.equal(false);
            expect(POW_OPERATOR.test(code), '** operator').to.equal(false);
        });
    });
});
