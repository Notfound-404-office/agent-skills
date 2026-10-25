const IMMUTABLE_PROOF_PATHS = new Set([
  '/assets/acvm_js_bg-BawCIsJQ.wasm',
  '/assets/barretenberg-Bwi_mQhV.js',
  '/assets/barretenberg-threads-CQu7x8-M.js',
  '/assets/noirc_abi_wasm_bg-VozwQxgy.wasm',
  '/assets/hold-KmcNW90K.js',
  '/crs/bn254_g1_compressed_131072.dat',
  '/crs/bn254_g2.dat',
]);

export function cacheControlFor(pathname) {
  return IMMUTABLE_PROOF_PATHS.has(pathname)
    ? 'public, max-age=31536000, immutable'
    : 'no-store';
}
