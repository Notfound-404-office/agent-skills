// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Stateless batch reader for a deployed Protocol 404 Pool and Market.
/// @dev This contract never writes storage. Failed order reads are returned to the
///      caller instead of reverting the whole batch, so callers can retain the
///      original revert data for diagnostics.
interface IProtocol404BatchPool {
    function nullified(uint256 value) external view returns (bool);
    function knownRoot(uint256 value) external view returns (bool);
}

contract Protocol404BatchView {
    uint256 public constant MAX_BATCH = 256;
    bytes4 private constant ORDERS_SELECTOR = bytes4(keccak256("orders(uint256)"));

    IProtocol404BatchPool public immutable pool;
    address public immutable market;

    error BadConfig();
    error BatchTooLarge(uint256 length);

    constructor(address pool_, address market_) {
        if (pool_ == address(0) || market_ == address(0)) revert BadConfig();
        pool = IProtocol404BatchPool(pool_);
        market = market_;
    }

    function batchNullified(uint256[] calldata values) external view returns (bool[] memory result) {
        _checkLength(values.length);
        result = new bool[](values.length);
        for (uint256 i; i < values.length; ++i) result[i] = pool.nullified(values[i]);
    }

    function batchKnownRoots(uint256[] calldata values) external view returns (bool[] memory result) {
        _checkLength(values.length);
        result = new bool[](values.length);
        for (uint256 i; i < values.length; ++i) result[i] = pool.knownRoot(values[i]);
    }

    /// @dev Singular spelling kept as a convenient ABI alias for clients that
    ///      model this as a batch of `knownRoot` calls.
    function batchKnownRoot(uint256[] calldata values) external view returns (bool[] memory result) {
        _checkLength(values.length);
        result = new bool[](values.length);
        for (uint256 i; i < values.length; ++i) result[i] = pool.knownRoot(values[i]);
    }

    /// @return success Per-order success flag.
    /// @return result ABI-encoded `orders(uint256)` return data on success, or
    ///         the original revert data on failure.
    function batchOrders(uint256[] calldata orderIds)
        external
        view
        returns (bool[] memory success, bytes[] memory result)
    {
        _checkLength(orderIds.length);
        success = new bool[](orderIds.length);
        result = new bytes[](orderIds.length);
        for (uint256 i; i < orderIds.length; ++i) {
            (success[i], result[i]) = market.staticcall(abi.encodeWithSelector(ORDERS_SELECTOR, orderIds[i]));
        }
    }

    function _checkLength(uint256 length) private pure {
        if (length > MAX_BATCH) revert BatchTooLarge(length);
    }
}
