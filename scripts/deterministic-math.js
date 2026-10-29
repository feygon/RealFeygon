'use strict';

// Source of truth: BurnRate-Private/scripts/deterministic-math.js. RealFeygon holds
// an identical copy (scripts/shared-files.json; checked by tests and deploy.sh).
//
// pow(x, y): line-for-line port of V8 11.3.244.8 src/base/ieee754.cc `pow` (the
// Math.pow of Node 18/20; git blob e71b63fd7c17711e5dc04d9acc040be0aa0b7c40).
// Node 24's Math.pow defers to the platform libm and differs by 1 ULP on ~6% of
// inputs, differently on Windows and Linux. This port uses only IEEE-754
// + - * /, Math.sqrt and Math.abs, so it is bit-identical everywhere.
// See docs/development/NODE24-SQLITE-ADAPTER-PRD.md, Addendum A.
//
// Derived from fdlibm e_pow.c:
// ====================================================
// Copyright (C) 2004 by Sun Microsystems, Inc. All rights reserved.
// Permission to use, copy, modify, and distribute this software is freely
// granted, provided that this notice is preserved.
// ====================================================

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/* istanbul ignore next: big-endian hardware cannot be exercised here (PRD A17) */
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1) {
    throw new Error('deterministic-math requires a little-endian platform');
}

function hiWord(x) {
    f64[0] = x;
    return u32[1] | 0;
}

function loWord(x) {
    f64[0] = x;
    return u32[0];
}

function clearLoWord(x) {
    f64[0] = x;
    u32[0] = 0;
    return f64[0];
}

function setHiWord(x, hi) {
    f64[0] = x;
    u32[1] = hi >>> 0;
    return f64[0];
}

const bp = [1.0, 1.5];
const dpH = [0.0, 5.84962487220764160156e-01];
const dpL = [0.0, 1.35003920212974897128e-08];
const two53 = 9007199254740992.0;
const huge = 1.0e300;
const tiny = 1.0e-300;
const L1 = 5.99999999999994648725e-01;
const L2 = 4.28571428578550184252e-01;
const L3 = 3.33333329818377432918e-01;
const L4 = 2.72728123808534006489e-01;
const L5 = 2.30660745775561754067e-01;
const L6 = 2.06975017800338417784e-01;
const P1 = 1.66666666666666019037e-01;
const P2 = -2.77777777770155933842e-03;
const P3 = 6.61375632143793436117e-05;
const P4 = -1.65339022054652515390e-06;
const P5 = 4.13813679705723846039e-08;
const lg2 = 6.93147180559945286227e-01;
const lg2H = 6.93147182464599609375e-01;
const lg2L = -1.90465429995776804525e-09;
const ovt = 8.0085662595372944372e-17;
const cp = 9.61796693925975554329e-01;
const cpH = 9.61796700954437255859e-01;
const cpL = -7.02846165095275826516e-09;
const ivln2 = 1.44269504088896338700e+00;
const ivln2H = 1.44269502162933349609e+00;
const ivln2L = 1.92596299112661746887e-08;
const twom54 = 5.55111512312578270212e-17;

// scalbn(z, n) for the only case pow reaches: z near 1, result subnormal.
// Same single rounding as scalbn: rescale exactly, then one multiply by 2^-54.
function scaleToSubnormal(z, n) {
    const hz = hiWord(z);
    const k = ((hz & 0x7ff00000) >> 20) + n + 54;
    return setHiWord(z, (hz & 0x800fffff) | (k << 20)) * twom54;
}

// 0 = y not an integer, 1 = odd integer, 2 = even integer (only computed for x < 0).
function integerKind(hx, iy, ly) {
    if (hx >= 0) return 0;
    if (iy >= 0x43400000) return 2;
    if (iy < 0x3ff00000) return 0;
    const k = (iy >> 20) - 0x3ff;
    if (k > 20) {
        const j = ly >>> (52 - k);
        return ((j << (52 - k)) >>> 0) === ly ? 2 - (j & 1) : 0;
    }
    if (ly === 0) {
        const j = iy >> (20 - k);
        return (j << (20 - k)) === iy ? 2 - (j & 1) : 0;
    }
    return 0;
}

// log2(|x|) as t1 + t2 when |y| > 2^31 and |1 - x| <= 2^-20.
function log2NearOne(ax) {
    const t = ax - 1.0;
    const w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
    const u = ivln2H * t;
    const v = t * ivln2L - w * ivln2;
    const t1 = clearLoWord(u + v);
    return { t1: t1, t2: v - (t1 - u) };
}

// log2(|x|) as t1 + t2 (extra-precise split), general case.
function log2Split(ax, ix) {
    let n = 0;
    if (ix < 0x00100000) {
        ax *= two53;
        n -= 53;
        ix = hiWord(ax);
    }
    n += (ix >> 20) - 0x3ff;
    const j = ix & 0x000fffff;
    let k;
    ix = j | 0x3ff00000;
    if (j <= 0x3988E) {
        k = 0;
    } else if (j < 0xBB67A) {
        k = 1;
    } else {
        k = 0;
        n += 1;
        ix -= 0x00100000;
    }
    ax = setHiWord(ax, ix);

    let u = ax - bp[k];
    let v = 1.0 / (ax + bp[k]);
    const ss = u * v;
    const sH = clearLoWord(ss);
    let tH = setHiWord(0.0, ((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18));
    let tL = ax - (tH - bp[k]);
    const sL = v * ((u - sH * tH) - sH * tL);
    let s2 = ss * ss;
    let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
    r += sL * (sH + ss);
    s2 = sH * sH;
    tH = clearLoWord(3.0 + s2 + r);
    tL = r - ((tH - 3.0) - s2);
    u = sH * tH;
    v = sL * tH + tL * ss;
    const pH = clearLoWord(u + v);
    const pL = v - (pH - u);
    const zH = cpH * pH;
    const zL = cpL * pH + pL * cp + dpL[k];
    const t = n;
    const t1 = clearLoWord(((zH + zL) + dpH[k]) + t);
    return { t1: t1, t2: zL - (((t1 - t) - dpH[k]) - zH) };
}

// s * 2^(pH + pL), with overflow and underflow handling.
function exp2Split(pH, pL, s) {
    let z = pL + pH;
    let j = hiWord(z);
    let i = loWord(z) | 0;
    if (j >= 0x40900000) {
        if (((j - 0x40900000) | i) !== 0) return s * huge * huge;
        if (pL + ovt > z - pH) return s * huge * huge;
    } else if ((j & 0x7fffffff) >= 0x4090cc00) {
        if (((j - 0xc090cc00) | i) !== 0) return s * tiny * tiny;
        if (pL <= z - pH) return s * tiny * tiny;
    }
    i = j & 0x7fffffff;
    let k = (i >> 20) - 0x3ff;
    let n = 0;
    if (i > 0x3fe00000) {
        n = j + (0x00100000 >> (k + 1));
        k = ((n & 0x7fffffff) >> 20) - 0x3ff;
        const t = setHiWord(0.0, n & ~(0x000fffff >> k));
        n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
        if (j < 0) n = -n;
        pH -= t;
    }
    let t = clearLoWord(pL + pH);
    const u = t * lg2H;
    const v = (pL - (t - pH)) * lg2 + t * lg2L;
    z = u + v;
    const w = v - (z - u);
    t = z * z;
    const t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    // V8 deviates from fdlibm here (correction term in the denominator); kept for bit-exactness.
    const r = (z * t1) / ((t1 - 2.0) - (w + z * w));
    z = 1.0 - (r - z);
    j = hiWord(z) + (n << 20);
    if ((j >> 20) <= 0) {
        z = scaleToSubnormal(z, n);
    } else {
        z = setHiWord(z, hiWord(z) + (n << 20));
    }
    return s * z;
}

function pow(x, y) {
    const hx = hiWord(x);
    const lx = loWord(x);
    const hy = hiWord(y);
    const ly = loWord(y);
    const ix = hx & 0x7fffffff;
    const iy = hy & 0x7fffffff;

    if ((iy | ly) === 0) return 1.0;
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) ||
        iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) {
        return x + y;
    }

    const yisint = integerKind(hx, iy, ly);

    if (ly === 0) {
        if (iy === 0x7ff00000) {
            if (((ix - 0x3ff00000) | lx) === 0) return y - y;
            if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
            return hy < 0 ? -y : 0.0;
        }
        if (iy === 0x3ff00000) return hy < 0 ? 1.0 / x : x;
        if (hy === 0x40000000) return x * x;
        if (hy === 0x3fe00000 && hx >= 0) return Math.sqrt(x);
    }

    const ax = Math.abs(x);
    if (lx === 0 && (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000)) {
        let z = ax;
        if (hy < 0) z = 1.0 / z;
        if (hx < 0) {
            if (((ix - 0x3ff00000) | yisint) === 0) {
                z = NaN;
            } else if (yisint === 1) {
                z = -z;
            }
        }
        return z;
    }

    const n = (hx >> 31) + 1;
    if ((n | yisint) === 0) return NaN;
    const s = (n | (yisint - 1)) === 0 ? -1.0 : 1.0;

    let split;
    if (iy > 0x41e00000) {
        if (iy > 0x43f00000) {
            if (ix <= 0x3fefffff) return hy < 0 ? huge * huge : tiny * tiny;
            // V8/fdlibm test ix >= 0x3ff00000 here, which is always true at this point.
            return hy > 0 ? huge * huge : tiny * tiny;
        }
        if (ix < 0x3fefffff) return hy < 0 ? s * huge * huge : s * tiny * tiny;
        if (ix > 0x3ff00000) return hy > 0 ? s * huge * huge : s * tiny * tiny;
        split = log2NearOne(ax);
    } else {
        split = log2Split(ax, ix);
    }

    const y1 = clearLoWord(y);
    const pL = (y - y1) * split.t1 + y * split.t2;
    const pH = y1 * split.t1;
    return exp2Split(pH, pL, s);
}

module.exports = { pow };
