// Poseidon2 sponge (BN254, t = 4, rate 3) over the stdlib permutation black box, the same
// construction as Barretenberg's poseidon2 hash and poseidon2-evm: the capacity element starts at
// len * 2^64, inputs are absorbed three at a time, and the output is state[0].
global TWO_POW_64: Field = 18446744073709551616;

fn sponge<let N: u32>(input: [Field; N]) -> Field {
    let mut state: [Field; 4] = [0, 0, 0, (N as Field) * TWO_POW_64];
    let mut cache: [Field; 3] = [0; 3];
    let mut size: u32 = 0;
    for i in 0..N {
        if size == 3 {
            for j in 0..3 {
                state[j] += cache[j];
            }
            state = std::hash::poseidon2_permutation(state);
            cache = [0; 3];
            size = 0;
        }
        cache[size] = input[i];
        size += 1;
    }
    for j in 0..3 {
        if j < size {
            state[j] += cache[j];
        }
    }
    state = std::hash::poseidon2_permutation(state);
    state[0]
}

pub fn h2(input: [Field; 2]) -> Field {
    sponge(input)
}

pub fn h3(input: [Field; 3]) -> Field {
    sponge(input)
}

pub fn h4(input: [Field; 4]) -> Field {
    sponge(input)
}
