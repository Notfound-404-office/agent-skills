// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IProtocol404Core, IProtocol404Hasher, IProtocol404Verifier} from "./IProtocol404Core.sol";
import {Protocol404PoolToken} from "./Protocol404PoolToken.sol";

contract Protocol404Pool is IProtocol404Core {
    uint32 public constant TOKEN_ASSET = 0;
    uint32 public constant override NATIVE = 1;
    uint8 public constant override ASSET_ID_BITS = 32;
    uint256 public constant override NATIVE_UNIT = 1e10;
    uint64 public constant MAX_PAUSE = 7 days;
    uint64 public constant PAUSE_COOLDOWN = 3 days;
    uint256 public constant FIELD = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    uint256 public constant NOTE_DOMAIN = 0x300a680891f7015ae938170cc59410fd790c8cdaf3f2987fbbd47b248a918f55;
    uint256 public constant NOTE_CIPHERTEXT_LENGTH = 175;
    bytes32 public constant AUTH_TYPEHASH = keccak256(
        "Shield(address owner,uint64 amount,uint64 fee,address relayer,uint256 inner,bytes32 ciphertextHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("404");
    bytes32 private constant VERSION_HASH = keccak256("2");
    uint256 private constant HALF_SECP256K1_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Config {
        IProtocol404Verifier transferVerifier;
        IProtocol404Hasher hasher;
        uint64 lot;
        uint256 maxLots;
        uint256 price;
        uint256 maxPerTx;
        uint256 mintStart;
        address treasury;
        address guardian;
        string tokenName;
        string tokenSymbol;
        uint8 tokenDecimals;
    }

    struct ShieldPermit {
        address owner;
        uint64 amount;
        uint64 fee;
        address relayer;
        uint256 inner;
        uint256 deadline;
    }

    IProtocol404Verifier public immutable transferVerifier;
    IProtocol404Hasher public immutable hasher;
    Protocol404PoolToken public immutable tokenContract;
    address public immutable override mintGate;
    address public immutable override treasury;
    uint64 public immutable override lot;
    uint256 public immutable maxLots;
    uint256 public immutable override price;
    uint256 public immutable override maxPerTx;
    uint256 public immutable mintStart;

    address public guardian;
    uint64 public pausedUntil;
    uint64 public nextPauseAllowedAt;
    uint256 public mintedLots;
    uint256 public mintProceeds;
    uint256 public override currentRoot;
    uint256 public nextIndex;
    uint256 public nullifierCount;
    bytes32 public nullifierDigest;
    bytes32 public transactionDigest;
    uint256 public activityCount;

    mapping(uint256 => uint256) public override poolBalance;
    mapping(address => uint256) public nonces;
    mapping(uint256 => bool) public knownRoot;
    mapping(uint256 => bool) public nullified;
    uint256[32] private zeros;
    uint256[32] private filledSubtrees;
    uint64[] private activity;
    bool private entered;

    event GuardianRenounced();
    event Minted(address indexed payer, uint256 leafIndex);
    event NoteAdded(uint256 indexed leafIndex, uint256 commitment, bytes ciphertext);
    event Nullified(uint256 indexed nullifier);
    event PausedUntil(uint64 until);
    event RootAdded(uint256 root);
    event Shielded(address indexed from, uint256 indexed leafIndex, uint32 asset, uint256 amount);
    event Swept(address indexed treasury, uint256 amount);
    event Transacted(bytes32 indexed requestDigest);
    event Unshielded(address indexed to, uint32 asset, uint256 amount);

    error BadAmount();
    error BadAsset();
    error BadCiphertext();
    error BadConfig();
    error BadCount();
    error BadSignature();
    error DuplicateNullifier();
    error ExceedsPoolBalance();
    error Expired();
    error FutureTimestamp();
    error InvalidProof();
    error MintNotStarted();
    error MissingRecipient();
    error MissingRelayer();
    error NotAField();
    error NotGuardian();
    error NotMintGate();
    error NullifierSpent();
    error PauseNotAllowed();
    error Paused();
    error ReentrancyGuardReentrantCall();
    error SoldOut();
    error TransferFailed();
    error TreeFull();
    error UnknownRoot();
    error WrongCaller();
    error WrongPayment();

    constructor(Config memory c, address mintGate_) {
        if (
            address(c.transferVerifier) == address(0) || address(c.hasher) == address(0) || c.lot == 0
                || c.maxLots == 0 || c.maxPerTx == 0 || c.treasury == address(0) || mintGate_ == address(0)
        ) revert BadConfig();
        transferVerifier = c.transferVerifier;
        hasher = c.hasher;
        lot = c.lot;
        maxLots = c.maxLots;
        price = c.price;
        maxPerTx = c.maxPerTx;
        mintStart = c.mintStart;
        treasury = c.treasury;
        guardian = c.guardian;
        mintGate = mintGate_;
        tokenContract = new Protocol404PoolToken(c.tokenName, c.tokenSymbol, c.tokenDecimals);

        uint256 zero;
        for (uint256 level; level < 32; ++level) {
            zeros[level] = zero;
            filledSubtrees[level] = zero;
            zero = c.hasher.hash2(zero, zero);
        }
        currentRoot = zero;
        knownRoot[zero] = true;
    }

    modifier nonReentrant() {
        if (entered) revert ReentrancyGuardReentrantCall();
        entered = true;
        _;
        entered = false;
    }

    modifier whenNotPaused() {
        if (block.timestamp < pausedUntil) revert Paused();
        _;
    }

    function token() external view override returns (address) { return address(tokenContract); }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function eip712Domain()
        external view
        returns (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] memory extensions)
    {
        return (hex"0f", "404", "2", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function extHash(ExtData calldata ext) public view returns (uint256) {
        return uint256(keccak256(abi.encodePacked(
            block.chainid, address(this), ext.recipient, ext.relayer, ext.caller, ext.data,
            ext.ciphertexts[0], ext.ciphertexts[1]
        ))) % FIELD;
    }

    function transact(bytes calldata proof, TxPublic calldata pub, ExtData calldata ext)
        external override whenNotPaused nonReentrant
    {
        if (ext.caller != address(0) && ext.caller != msg.sender) revert WrongCaller();
        if (!knownRoot[pub.root]) revert UnknownRoot();
        if (pub.nullifiers[0] == pub.nullifiers[1]) revert DuplicateNullifier();
        if (nullified[pub.nullifiers[0]] || nullified[pub.nullifiers[1]]) revert NullifierSpent();
        if (pub.nowTs > block.timestamp) revert FutureTimestamp();
        _checkAsset(pub.asset);
        uint256 totalOut = uint256(pub.publicOut) + uint256(pub.fee);
        if (totalOut > poolBalance[pub.asset]) revert ExceedsPoolBalance();
        if (pub.publicOut != 0 && ext.recipient == address(0)) revert MissingRecipient();
        if (pub.fee != 0 && ext.relayer == address(0)) revert MissingRelayer();
        _checkCiphertext(ext.ciphertexts[0]);
        _checkCiphertext(ext.ciphertexts[1]);
        _checkField(pub.nullifiers[0]);
        _checkField(pub.nullifiers[1]);
        _checkField(pub.commitments[0]);
        _checkField(pub.commitments[1]);

        bytes32[] memory inputs = new bytes32[](10);
        inputs[0] = bytes32(pub.root);
        inputs[1] = bytes32(pub.nullifiers[0]);
        inputs[2] = bytes32(pub.nullifiers[1]);
        inputs[3] = bytes32(pub.commitments[0]);
        inputs[4] = bytes32(pub.commitments[1]);
        inputs[5] = bytes32(uint256(pub.nowTs));
        inputs[6] = bytes32(uint256(pub.asset));
        inputs[7] = bytes32(uint256(pub.publicOut));
        inputs[8] = bytes32(uint256(pub.fee));
        inputs[9] = bytes32(extHash(ext));
        if (!transferVerifier.verify(proof, inputs)) revert InvalidProof();

        nullified[pub.nullifiers[0]] = true;
        nullified[pub.nullifiers[1]] = true;
        nullifierCount += 2;
        nullifierDigest = keccak256(abi.encodePacked(nullifierDigest, pub.nullifiers[0]));
        nullifierDigest = keccak256(abi.encodePacked(nullifierDigest, pub.nullifiers[1]));
        emit Nullified(pub.nullifiers[0]);
        emit Nullified(pub.nullifiers[1]);

        uint256 index = _insertPair(pub.commitments[0], pub.commitments[1]);
        emit NoteAdded(index, pub.commitments[0], ext.ciphertexts[0]);
        emit NoteAdded(index + 1, pub.commitments[1], ext.ciphertexts[1]);
        poolBalance[pub.asset] -= totalOut;

        bytes32 requestDigest = keccak256(abi.encodePacked(
            pub.root,
            pub.nullifiers[0],
            pub.nullifiers[1],
            pub.commitments[0],
            pub.commitments[1],
            uint256(pub.nowTs),
            uint256(pub.asset),
            uint256(pub.publicOut),
            uint256(pub.fee),
            extHash(ext)
        ));
        transactionDigest = keccak256(abi.encodePacked(transactionDigest, requestDigest));
        _recordActivity();
        emit Transacted(requestDigest);

        if (pub.publicOut != 0) {
            _payout(pub.asset, ext.recipient, pub.publicOut);
            emit Unshielded(ext.recipient, pub.asset, pub.publicOut);
        }
        if (pub.fee != 0) _payout(pub.asset, ext.relayer, pub.fee);
    }

    function shield(uint32 asset, uint64 amount, uint256 inner, bytes calldata ciphertext)
        external payable override whenNotPaused nonReentrant
    {
        if (amount == 0) revert BadAmount();
        _checkCiphertext(ciphertext);
        _checkField(inner);
        _takeDeposit(asset, msg.sender, amount);
        uint256 index = _addNote(asset, amount, inner, ciphertext);
        emit Shielded(msg.sender, index, asset, amount);
        _recordActivity();
    }

    function shieldWithSig(ShieldPermit calldata p, bytes calldata ciphertext, bytes calldata signature)
        external whenNotPaused nonReentrant
    {
        if (p.owner == address(0) || p.amount == 0) revert BadAmount();
        if (p.deadline < block.timestamp) revert Expired();
        if (p.fee != 0 && p.relayer == address(0)) revert MissingRelayer();
        _checkCiphertext(ciphertext);
        _checkField(p.inner);

        uint256 nonce = nonces[p.owner]++;
        bytes32 structHash = keccak256(abi.encode(
            AUTH_TYPEHASH, p.owner, p.amount, p.fee, p.relayer, p.inner,
            keccak256(ciphertext), nonce, p.deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        if (_recover(digest, signature) != p.owner) revert BadSignature();

        tokenContract.burn(p.owner, uint256(p.amount) + uint256(p.fee));
        if (p.fee != 0) tokenContract.mint(p.relayer, p.fee);
        uint256 index = _addNote(TOKEN_ASSET, p.amount, p.inner, ciphertext);
        emit Shielded(p.owner, index, TOKEN_ASSET, p.amount);
        _recordActivity();
    }

    function mint(uint256[] calldata inners, bytes[] calldata ciphertexts)
        external payable override whenNotPaused nonReentrant
    {
        if (msg.sender != mintGate) revert NotMintGate();
        if (block.timestamp < mintStart) revert MintNotStarted();
        uint256 count = inners.length;
        if (count == 0 || count > maxPerTx || ciphertexts.length != count) revert BadCount();
        if (mintedLots + count > maxLots) revert SoldOut();
        if (msg.value != count * price) revert WrongPayment();

        mintedLots += count;
        mintProceeds += msg.value;
        for (uint256 i; i < count; ++i) {
            _checkField(inners[i]);
            _checkCiphertext(ciphertexts[i]);
            uint256 index = _addNote(TOKEN_ASSET, lot, inners[i], ciphertexts[i]);
            emit Minted(msg.sender, index);
        }
        _recordActivity();
    }

    function sweep() external nonReentrant {
        uint256 amount = mintProceeds;
        mintProceeds = 0;
        emit Swept(treasury, amount);
        (bool ok,) = payable(treasury).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function pause(uint64 duration) external {
        if (msg.sender != guardian) revert NotGuardian();
        if (duration == 0 || duration > MAX_PAUSE || block.timestamp < nextPauseAllowedAt) revert PauseNotAllowed();
        pausedUntil = uint64(block.timestamp) + duration;
        nextPauseAllowedAt = uint64(block.timestamp) + PAUSE_COOLDOWN;
        emit PausedUntil(pausedUntil);
    }

    function unpause() external {
        if (msg.sender != guardian) revert NotGuardian();
        pausedUntil = 0;
        emit PausedUntil(0);
    }

    function renounceGuardian() external {
        if (msg.sender != guardian) revert NotGuardian();
        guardian = address(0);
        pausedUntil = 0;
        emit GuardianRenounced();
    }

    function activityBlocks(uint256 start, uint256 count) external view returns (uint64[] memory out) {
        if (start >= activity.length) return new uint64[](0);
        uint256 end = start + count;
        if (end > activity.length) end = activity.length;
        out = new uint64[](end - start);
        for (uint256 i; i < out.length; ++i) out[i] = activity[start + i];
    }

    function _takeDeposit(uint32 asset, address from, uint64 amount) private {
        _checkAsset(asset);
        if (asset == TOKEN_ASSET) {
            if (msg.value != 0) revert WrongPayment();
            tokenContract.burn(from, amount);
        } else if (msg.value != uint256(amount) * NATIVE_UNIT) {
            revert WrongPayment();
        }
    }

    function _addNote(uint32 asset, uint64 amount, uint256 inner, bytes calldata ciphertext)
        private returns (uint256 index)
    {
        uint256 valueAndAsset = uint256(amount) + (uint256(asset) << 64);
        uint256 commitment = hasher.hash3(NOTE_DOMAIN, valueAndAsset, inner);
        _checkField(commitment);
        poolBalance[asset] += amount;
        index = _insertPair(commitment, 0);
        emit NoteAdded(index, commitment, ciphertext);
    }

    function _insertPair(uint256 left, uint256 right) private returns (uint256 index) {
        index = nextIndex;
        if (index > type(uint32).max - 1) revert TreeFull();
        uint256 current = hasher.hash2(left, right);
        uint256 path = index >> 1;
        for (uint256 level = 1; level < 32; ++level) {
            if (path & 1 == 0) {
                filledSubtrees[level] = current;
                current = hasher.hash2(current, zeros[level]);
            } else {
                current = hasher.hash2(filledSubtrees[level], current);
            }
            path >>= 1;
        }
        nextIndex = index + 2;
        currentRoot = current;
        knownRoot[current] = true;
        emit RootAdded(current);
    }

    function _payout(uint32 asset, address to, uint64 amount) private {
        if (asset == TOKEN_ASSET) {
            tokenContract.mint(to, amount);
        } else {
            (bool ok,) = payable(to).call{value: uint256(amount) * NATIVE_UNIT}("");
            if (!ok) revert TransferFailed();
        }
    }

    function _recordActivity() private {
        uint64 currentBlock = uint64(block.number);
        if (activity.length != 0 && activity[activity.length - 1] == currentBlock) return;
        activity.push(currentBlock);
        activityCount = activity.length;
    }

    function _checkAsset(uint32 asset) private pure {
        if (asset > NATIVE) revert BadAsset();
    }

    function _checkCiphertext(bytes calldata ciphertext) private pure {
        if (ciphertext.length != NOTE_CIPHERTEXT_LENGTH) revert BadCiphertext();
    }

    function _checkField(uint256 value) private pure {
        if (value >= FIELD) revert NotAField();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > HALF_SECP256K1_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    receive() external payable { revert WrongPayment(); }
}
