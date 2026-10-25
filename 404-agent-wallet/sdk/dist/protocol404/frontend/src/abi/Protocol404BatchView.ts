import { parseAbi } from 'viem';

/** Stateless batch reader deployed beside the active BSC Pool and Market. */
export default parseAbi([
  'function pool() view returns (address)',
  'function market() view returns (address)',
  'function MAX_BATCH() view returns (uint256)',
  'function batchNullified(uint256[] values) view returns (bool[])',
  'function batchKnownRoot(uint256[] values) view returns (bool[])',
  'function batchKnownRoots(uint256[] values) view returns (bool[])',
  'function batchOrders(uint256[] orderIds) view returns (bool[] success,bytes[] result)',
]);
