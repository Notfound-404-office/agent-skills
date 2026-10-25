// Shared note relations (SPEC 4.4, 4.5, 4.7). Every hash is a Poseidon2 sponge of 2 to 4 inputs.
pub mod hash;
pub mod domains;

use hash::{h2, h3, h4};
use domains::{D_INNER, D_LOC, D_NF, D_NKC, D_NOTE, D_OWNER, D_SPEND, D_TAG, D_TAG_DUMMY};

pub global TREE_DEPTH: u32 = 32;
/// Asset ids are u32. The initial registry assigns 0 to 404 and 1 to the native coin.
pub global ASSET_SHIFT: Field = 18446744073709551616; // 2^64

pub fn spend_pub(sk: Field) -> Field {
    h2([D_SPEND, sk])
}

pub fn nk_commit(nk: Field) -> Field {
    h2([D_NKC, nk])
}

pub fn owner(spend_pub: Field, nkc: Field, d: Field) -> Field {
    h4([D_OWNER, spend_pub, nkc, d])
}

pub fn inner(owner: Field, lock_until: u64, rcm: Field) -> Field {
    h4([D_INNER, owner, lock_until as Field, rcm])
}

/// The asset rides above the 64-bit value in one field element, so the contract still hashes three
/// inputs; asset 0 gives exactly P3(D_NOTE, value, inner).
pub fn commitment(asset: u32, value: u64, inner: Field) -> Field {
    h3([D_NOTE, value as Field + (asset as Field) * ASSET_SHIFT, inner])
}

pub fn location(cm: Field, leaf_index: u32) -> Field {
    h3([D_LOC, cm, leaf_index as Field])
}

pub fn nullifier(nk: Field, loc: Field) -> Field {
    h3([D_NF, nk, loc])
}

pub fn hold_tag(nk: Field, loc: Field, campaign_id: Field) -> Field {
    h4([D_TAG, nk, loc, campaign_id])
}

pub fn dummy_tag(r: Field, campaign_id: Field) -> Field {
    h3([D_TAG_DUMMY, r, campaign_id])
}

/// Bit i of `index` says whether the node at depth i is a right child.
pub fn merkle_root(leaf: Field, index: u32, path: [Field; TREE_DEPTH]) -> Field {
    let mut current = leaf;
    for i in 0..TREE_DEPTH {
        let right = ((index >> i) & 1) == 1;
        current = h2(if right { [path[i], current] } else { [current, path[i]] });
    }
    current
}
