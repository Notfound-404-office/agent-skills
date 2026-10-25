// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IProtocol404Core} from "./IProtocol404Core.sol";

contract Protocol404Bundle {
    uint32 public constant NATIVE = 1;
    IProtocol404Core public immutable pool;
    bool private entered;

    error BadConfig();
    error ReentrancyGuardReentrantCall();
    error WrongAction();
    error WrongFee();

    constructor(address pool_) {
        if (pool_ == address(0)) revert BadConfig();
        pool = IProtocol404Core(pool_);
    }

    function actionData(address target, bytes calldata callData) public pure returns (bytes32) {
        return keccak256(abi.encode(target, keccak256(callData)));
    }

    function relay(
        bytes calldata proof,
        IProtocol404Core.TxPublic calldata pub,
        IProtocol404Core.ExtData calldata ext,
        address target,
        bytes calldata callData
    ) external {
        if (entered) revert ReentrancyGuardReentrantCall();
        entered = true;

        if (
            ext.caller != address(this) || ext.data != actionData(target, callData)
                || target == address(this) || target.code.length == 0
        ) revert WrongAction();
        if (pub.asset != NATIVE || pub.fee == 0) revert WrongFee();

        pool.transact(proof, pub, ext);
        (bool ok, bytes memory result) = target.call(callData);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        entered = false;
    }
}
