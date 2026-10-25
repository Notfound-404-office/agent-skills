import { poseidonHash2 } from './poseidon.ts';

/** @orig index-CVtw0LZh.js:19505 Gw Empty roots for every depth of the 32-level note tree. */
export const EMPTY_ROOTS: readonly bigint[] = (() => {
  const roots = [0n];
  for (let depth = 0; depth < 32; depth++) roots.push(poseidonHash2(roots[depth]!, roots[depth]!));
  return Object.freeze(roots);
})();

/** @orig index-CVtw0LZh.js:19511 Kw Incrementally cached 32-level Poseidon2 Merkle tree. */
export class IncrementalMerkleTree {
  readonly levels: bigint[][] = Array.from({ length: 33 }, () => []);
  private dirtyFrom = Infinity;

  get leaves(): bigint[] { return this.levels[0]!; }
  get size(): number { return this.leaves.length; }

  /** @orig index-CVtw0LZh.js:19523 Kw.insertPair Insert two adjacent commitments. */
  insertPair(left: bigint, right: bigint): number {
    if (this.leaves.length % 2 !== 0) throw new Error('pair insertion must start at an even index');
    this.leaves.push(left, right);
    this.touch(this.leaves.length - 2);
    return this.leaves.length - 2;
  }

  /** @orig index-CVtw0LZh.js:19528 Kw.insertSingle Insert a commitment with an explicit zero sibling. */
  insertSingle(leaf: bigint): number { return this.insertPair(leaf, 0n); }

  /** @orig index-CVtw0LZh.js:19531 Kw.setLeaf Set a sparse leaf and invalidate cached parents. */
  setLeaf(index: number, leaf: bigint): void {
    this.touch(Math.min(index, this.leaves.length));
    while (this.leaves.length <= index) this.leaves.push(0n);
    this.leaves[index] = leaf;
  }

  /** @orig index-CVtw0LZh.js:19536 Kw.leaf Read a leaf, treating absent entries as zero. */
  leaf(index: number): bigint { return this.leaves[index] ?? 0n; }

  /** @orig index-CVtw0LZh.js:19539 Kw.root Return the current depth-32 root. */
  root(): bigint {
    this.refresh();
    return this.levels[32]![0] ?? EMPTY_ROOTS[32]!;
  }

  /** @orig index-CVtw0LZh.js:19542 Kw.path Return the 32 siblings proving an existing leaf. */
  path(index: number): bigint[] {
    if (index < 0 || index >= this.size) throw new RangeError('leaf index out of range');
    this.refresh();
    const path: bigint[] = [];
    for (let depth = 0; depth < 32; depth++) {
      path.push(this.levels[depth]![index % 2 === 0 ? index + 1 : index - 1] ?? EMPTY_ROOTS[depth]!);
      index = Math.floor(index / 2);
    }
    return path;
  }

  private touch(index: number): void {
    if (index < this.dirtyFrom) this.dirtyFrom = index;
  }

  private refresh(): void {
    if (this.dirtyFrom === Infinity) return;
    let start = this.dirtyFrom;
    for (let depth = 0; depth < 32; depth++) {
      const current = this.levels[depth]!;
      const parent = this.levels[depth + 1]!;
      start -= start % 2;
      for (let index = start; index < current.length; index += 2) {
        parent[index / 2] = poseidonHash2(current[index]!, current[index + 1] ?? EMPTY_ROOTS[depth]!);
      }
      start /= 2;
    }
    this.dirtyFrom = Infinity;
  }
}
