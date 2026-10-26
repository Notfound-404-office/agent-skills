// SPEC 6.2: prove at least `threshold` 404 token locked until at least `min_lock`, using up to 4 notes.
use pm_lib::{commitment, dummy_tag, hold_tag, inner, location, merkle_root, nk_commit, owner, spend_pub, TREE_DEPTH};

fn main(
    root: pub Field,
    threshold: pub u64,
    min_lock: pub u64,
    campaign_id: pub Field,
    // Claim address or challenge; bound to the proof as a public input.
    binding: pub Field,
    tags: pub [Field; 4],
    sk: Field,
    nk: Field,
    value: [u64; 4],
    d: [Field; 4],
    lock: [u64; 4],
    rcm: [Field; 4],
    index: [u32; 4],
    path: [[Field; TREE_DEPTH]; 4],
    dummy_r: [Field; 4],
) {
    assert(sk != 0);
    assert(nk != 0);
    assert(threshold != 0);
    let spk = spend_pub(sk);
    let nkc = nk_commit(nk);

    let mut locs: [Field; 4] = [0; 4];
    let mut total: u128 = 0;
    for i in 0..4 {
        if value[i] != 0 {
            // 404 token notes only (asset 0): other assets do not count toward a holding.
            let cm = commitment(0, value[i], inner(owner(spk, nkc, d[i]), lock[i], rcm[i]));
            assert_eq(merkle_root(cm, index[i], path[i]), root);
            // Locked past min_lock, so it cannot have been spent while the campaign is open.
            assert(lock[i] >= min_lock);
            let loc = location(cm, index[i]);
            assert_eq(tags[i], hold_tag(nk, loc, campaign_id));
            locs[i] = loc;
        } else {
            assert(dummy_r[i] != 0);
            assert_eq(tags[i], dummy_tag(dummy_r[i], campaign_id));
        }
        total += value[i] as u128;
    }
    // The same note may not be counted twice in one proof.
    for i in 0..4 {
        for j in 0..4 {
            if (i < j) & (value[i] != 0) & (value[j] != 0) {
                assert(locs[i] != locs[j]);
            }
        }
    }
    assert(total >= threshold as u128);
}
