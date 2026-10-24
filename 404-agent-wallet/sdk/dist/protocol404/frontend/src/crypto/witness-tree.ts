import { assertField, assertU32 } from './bytes.ts';
import { poseidonHash2 } from './poseidon.ts';

const TREE_DEPTH = 32;

export interface NoteWitnessTree {
  root(): bigint;
  leaf(index: number): bigint;
  path(index: number): readonly bigint[];
}

/** Recompute and validate a depth-32 note-tree membership proof. */
export function assertNoteMembership(
  root: bigint,
  index: number,
  leaf: bigint,
  path: readonly bigint[],
): void {
  assertU32(index, 'leaf index');
  assertField(root, 'root');
  let node = assertField(leaf, 'leaf');
  if (path.length !== TREE_DEPTH) throw new RangeError(`Merkle path must contain ${TREE_DEPTH} siblings`);

  let position = index;
  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const sibling = assertField(path[depth]!, `path[${depth}]`);
    node = position % 2 === 0
      ? poseidonHash2(node, sibling)
      : poseidonHash2(sibling, node);
    position = Math.floor(position / 2);
  }
  if (node !== root) throw new Error('Merkle path does not match root');
}

type StoredWitness = Readonly<{ leaf: bigint; path: readonly bigint[] }>;

/** Fixed-root note tree that retains only explicitly supplied membership witnesses. */
export class LightWitnessTree implements NoteWitnessTree {
  readonly #root: bigint;
  readonly #witnesses = new Map<number, StoredWitness>();

  constructor(root: bigint) {
    this.#root = assertField(root, 'root');
  }

  root(): bigint {
    return this.#root;
  }

  addWitness(index: number, commitment: bigint, path: readonly bigint[]): void {
    assertNoteMembership(this.#root, index, commitment, path);
    this.#witnesses.set(index, { leaf: commitment, path: Object.freeze(path.slice()) });
  }

  leaf(index: number): bigint {
    assertU32(index, 'leaf index');
    const witness = this.#witnesses.get(index);
    if (!witness) throw new Error(`no witness for leaf ${index}`);
    return witness.leaf;
  }

  path(index: number): readonly bigint[] {
    assertU32(index, 'leaf index');
    const witness = this.#witnesses.get(index);
    if (!witness) throw new Error(`no witness for leaf ${index}`);
    return witness.path.slice();
  }
}
