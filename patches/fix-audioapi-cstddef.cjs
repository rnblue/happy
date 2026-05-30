/**
 * react-native-audio-api's core/Constants.h declares `size_t MAX_FFT_SIZE`
 * but only includes <cmath> and <limits>, neither of which is guaranteed to
 * pull in `size_t`. Under the stricter libc++ headers shipped with recent
 * Xcode/iOS SDKs this fails to compile with:
 *   error: unknown type name 'size_t'; did you mean 'std::size_t'?
 * Constants.h is included transitively across the pod, so adding the missing
 * <cstddef> here fixes the whole RNAudioAPI target.
 *
 * Idempotent. Usage: `node patches/fix-audioapi-cstddef.cjs`
 */
const fs = require('fs');
const path = require('path');

const headerPath = path.resolve(
    __dirname,
    '..',
    'node_modules',
    'react-native-audio-api',
    'common',
    'cpp',
    'audioapi',
    'core',
    'Constants.h',
);

if (!fs.existsSync(headerPath)) {
    console.warn('[fix-audioapi-cstddef] Constants.h not found at', headerPath, '— skipping');
    return;
}

const src = fs.readFileSync(headerPath, 'utf8');
if (src.includes('<cstddef>')) {
    console.log('[fix-audioapi-cstddef] already patched — skipping');
    return;
}

// Insert <cstddef> right after the first existing #include so the type is
// available before MAX_FFT_SIZE uses size_t.
const patched = src.replace(/(#include <cmath>\n)/, '$1#include <cstddef>\n');
if (patched === src) {
    console.warn('[fix-audioapi-cstddef] anchor "#include <cmath>" not found — skipping');
    return;
}

fs.writeFileSync(headerPath, patched, 'utf8');
console.log('[fix-audioapi-cstddef] added #include <cstddef> to Constants.h');
