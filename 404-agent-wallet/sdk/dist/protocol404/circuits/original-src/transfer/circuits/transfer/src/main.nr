// SPEC 6.1: 2-in-2-out private transfer of one asset, optional unshield (public_out) and relayer fee.
use pm_lib::{commitment, inner, location, merkle_root, nk_commit, nullifier, owner, spend_pub, TREE_DEPTH};

fn main(
    root: pub Field,
    nullifiers: pub [Field; 2],
    commitments: pub [Field; 2],
    now: pub u64,
    // Every note of the transaction holds this asset; public_out and fee are paid in it too.
    asset: pub u8,
    public_out: pub u64,
    fee: pub u64,
    // Hash of recipient, relayer, caller, app data, ciphertexts, chain and pool. Unused in
    // constraints: UltraHonk binds every public input to the proof (checked by the tamper tests).
    ext_hash: pub Field,
    sk: Field,
    nk: Field,
    in_value: [u64; 2],
    in_d: [Field; 2],
    in_lock: [u64; 2],
    in_rcm: [Field; 2],
    in_index: [u32; 2],
    in_path: [[Field; TREE_DEPTH]; 2],
    out_value: [u64; 2],
    out_owner: [Field; 2],
    out_lock: [u64; 2],
    out_rcm: [Field; 2],
) {
    assert(sk != 0);
    assert(nk != 0);
    let spk = spend_pub(sk);
    let nkc = nk_commit(nk);

    let mut total_in: u128 = 0;
    for i in 0..2 {
        let cm = commitment(asset, in_value[i], inner(owner(spk, nkc, in_d[i]), in_lock[i], in_rcm[i]));
        // Every slot publishes a nullifier; a zero-value dummy's looks just as random.
        assert_eq(nullifiers[i], nullifier(nk, location(cm, in_index[i])));
        if in_value[i] != 0 {
            assert_eq(merkle_root(cm, in_index[i], in_path[i]), root);
            assert(in_lock[i] <= now);
        }
        total_in += in_value[i] as u128;
    }
    assert(nullifiers[0] != nullifiers[1]);

    let mut total_out: u128 = (public_out as u128) + (fee as u128);
    for j in 0..2 {
        assert_eq(commitments[j], commitment(asset, out_value[j], inner(out_owner[j], out_lock[j], out_rcm[j])));
        total_out += out_value[j] as u128;
    }
    assert_eq(total_in, total_out);
}
