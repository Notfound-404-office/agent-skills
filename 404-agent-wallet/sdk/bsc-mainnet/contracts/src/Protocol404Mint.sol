// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IProtocol404Core} from "./IProtocol404Core.sol";

interface IProtocol404Membership {
    function balanceOf(address owner) external view returns (uint256);
}

contract Protocol404Mint {
    uint256 private constant NOTE_CIPHERTEXT_LENGTH = 175;
    uint256 private constant MINT_ONCE_SLOT =
        0x4a9e59ae29245ef25e451579b691f0307c4c39027041b828aa614be3838a9cb4;

    IProtocol404Core public immutable pool;
    IProtocol404Membership public immutable membershipNft;
    mapping(address => uint8) public mintedBy;

    event PrivateMint(address indexed submitter, uint256 totalMinted);

    error BadPool();
    error BadPoolTemplate();
    error MintLimit();
    error NotMember();
    error OneMintPerTransaction();
    error UnexpectedPayment();
    error WrongMint();
    error WrongPayment();

    constructor(address pool_, address membershipNft_) {
        if (pool_ == address(0) || pool_.code.length == 0 || membershipNft_ == address(0) || membershipNft_.code.length == 0) {
            revert BadPool();
        }
        IProtocol404Core configuredPool = IProtocol404Core(pool_);
        if (configuredPool.mintGate() != address(this) || configuredPool.maxPerTx() != 1) revert BadPoolTemplate();
        pool = configuredPool;
        membershipNft = IProtocol404Membership(membershipNft_);
    }

    function mintData(uint256[] calldata inners, bytes[] calldata ciphertexts) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](ciphertexts.length);
        for (uint256 i; i < ciphertexts.length; ++i) hashes[i] = keccak256(ciphertexts[i]);
        return keccak256(abi.encode(inners, hashes));
    }

    function privateMint(
        bytes calldata proof,
        IProtocol404Core.TxPublic calldata pub,
        IProtocol404Core.ExtData calldata ext,
        uint256[] calldata inners,
        bytes[] calldata ciphertexts
    ) external {
        if (membershipNft.balanceOf(msg.sender) == 0) revert NotMember();
        if (inners.length != 1 || ciphertexts.length != 1 || ciphertexts[0].length != NOTE_CIPHERTEXT_LENGTH) {
            revert WrongMint();
        }
        if (
            ext.caller != address(this) || ext.recipient != address(this) || ext.relayer != address(0)
                || ext.data != mintData(inners, ciphertexts)
        ) revert WrongMint();

        uint256 mintPrice = pool.price();
        if (pub.asset != pool.NATIVE() || pub.fee != 0 || uint256(pub.publicOut) * pool.NATIVE_UNIT() != mintPrice) {
            revert WrongPayment();
        }

        uint8 used = mintedBy[msg.sender];
        if (used >= 10) revert MintLimit();
        bool alreadyMinted;
        uint256 slot = MINT_ONCE_SLOT;
        assembly ("memory-safe") { alreadyMinted := tload(slot) }
        if (alreadyMinted) revert OneMintPerTransaction();
        assembly ("memory-safe") { tstore(slot, 1) }

        mintedBy[msg.sender] = used + 1;
        uint256 beforeBalance = address(this).balance;
        pool.transact(proof, pub, ext);
        if (address(this).balance != beforeBalance + mintPrice) revert WrongPayment();
        pool.mint{value: mintPrice}(inners, ciphertexts);
        if (address(this).balance != beforeBalance) revert WrongPayment();
        emit PrivateMint(msg.sender, used + 1);
    }

    receive() external payable {
        if (msg.sender != address(pool)) revert UnexpectedPayment();
    }
}
