import { parseAbi } from 'viem';

/** Independently implemented MarketV2. Payment proofs retain the existing pool ABI. */
export const txPublic = '(uint256 root,uint256[2] nullifiers,uint256[2] commitments,uint64 nowTs,uint32 asset,uint64 publicOut,uint64 fee)';
export const extData = '(address recipient,address relayer,address caller,bytes32 data,bytes[2] ciphertexts)';
export default parseAbi([
  'function feeBps() view returns (uint16)',
  'function feeOf(uint64 pay) view returns (uint64)',
  'function feesOwed(uint256 asset) view returns (uint256)',
  'function sweepFees()',
  'function pool() view returns (address)',
  'function token() view returns (address)',
  'function treasury() view returns (address)',
  'function orderCount() view returns (uint256)',
  'function orders(uint256 orderId) view returns ((uint32 sellAsset,bool open,uint32 releases,address maker,uint64 sellAmount,uint64 buyAmount,uint64 remaining,uint64 proceeds))',
  'function eip712Domain() view returns (bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)',
  `function placeOrder(bytes proof,${txPublic} pub,${extData} ext,(uint64 buyAmount,address maker) p) returns (uint256 orderId)`,
  `function fillPrivate(bytes proof,${txPublic} pub,${extData} ext,(uint256 orderId,uint64 pay,uint256 outInner,bytes outCiphertext) f)`,
  `function sweepPrivate(bytes proof,${txPublic} pub,${extData} ext,(uint256[] orderIds,uint64[] pays,uint64 minBought,uint256 boughtInner,bytes boughtCiphertext,uint256 restInner,bytes restCiphertext) s)`,
  'function fillPublic(uint256 orderId,uint64 pay,address to) payable returns (uint64 bought)',
  'function release(uint8 action,(uint256 orderId,uint256 inner,bytes ciphertext,address relayer,uint64 fee,uint256 deadline) r,bytes signature)',
  'event OrderPlaced(uint256 indexed orderId,address indexed maker,uint32 sellAsset,uint64 sellAmount,uint64 buyAmount)',
  'event OrderFilled(uint256 indexed orderId,uint64 paid,uint64 bought,uint64 fee,bool shielded)',
  'event OrderReleased(uint256 indexed orderId,uint8 action,uint64 amount,uint64 fee)',
]);
