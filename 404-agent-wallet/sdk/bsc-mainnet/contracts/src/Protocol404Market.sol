// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IProtocol404Core} from "./IProtocol404Core.sol";

interface IMarketV2Token {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Fixed-price order book that settles trades through private pool notes.
contract Protocol404Market {
    uint32 public constant TOKEN_ASSET = 0;
    uint32 public constant NATIVE = 1;
    uint8 public constant CLAIM = 0;
    uint8 public constant CANCEL = 1;
    uint64 public constant TOKEN_DUST = 1_000_000_000;
    uint64 public constant DUST_TOKEN = TOKEN_DUST; // Compatibility getter for the previous ABI.
    uint64 public constant DUST_NATIVE = 10_000;
    uint64 public constant MAX_BUY = 9_223_372_036_854_775_807;
    uint256 public constant NATIVE_UNIT = 1e10;

    bytes32 public constant RELEASE_TYPEHASH = keccak256(
        "Release(uint8 action,uint256 orderId,uint256 inner,bytes32 ciphertextHash,address relayer,uint64 fee,uint256 deadline,uint32 nonce)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("404 Market");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    IProtocol404Core public immutable pool;
    IMarketV2Token public immutable token;
    address public immutable treasury;
    uint16 public immutable feeBps;

    struct Order {
        uint32 sellAsset;
        bool open;
        uint32 releases;
        address maker;
        uint64 sellAmount;
        uint64 buyAmount;
        uint64 remaining;
        uint64 proceeds;
    }

    struct Place {
        uint64 buyAmount;
        address maker;
    }

    struct FillPrivate {
        uint256 orderId;
        uint64 pay;
        uint256 outInner;
        bytes outCiphertext;
    }

    struct Sweep {
        uint256[] orderIds;
        uint64[] pays;
        uint64 minBought;
        uint256 boughtInner;
        bytes boughtCiphertext;
        uint256 restInner;
        bytes restCiphertext;
    }

    struct Release {
        uint256 orderId;
        uint256 inner;
        bytes ciphertext;
        address relayer;
        uint64 fee;
        uint256 deadline;
    }

    Order[] private _orders;
    mapping(uint256 asset => uint256 amount) public feesOwed;
    uint256 private _locked = 1;

    event OrderPlaced(uint256 indexed orderId, address indexed maker, uint32 sellAsset, uint64 sellAmount, uint64 buyAmount);
    event OrderFilled(uint256 indexed orderId, uint64 paid, uint64 bought, uint64 fee, bool privateOutput);
    event OrderReleased(uint256 indexed orderId, uint8 action, uint64 amount, uint64 fee);

    error BadAmount();
    error BadAsset();
    error BadConfig();
    error BadSignature();
    error Closed();
    error DuplicateOrder();
    error Expired();
    error LeavesDust();
    error MissingRecipient();
    error NothingToRelease();
    error ReentrancyGuardReentrantCall();
    error TooMuch();
    error TransferFailed();
    error UnexpectedPayment();
    error WrongOrder();
    error WrongPayment();

    modifier nonReentrant() {
        if (_locked != 1) revert ReentrancyGuardReentrantCall();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address pool_, uint16 feeBps_) {
        if (pool_ == address(0) || feeBps_ > 1_000) revert BadConfig();
        IProtocol404Core configuredPool = IProtocol404Core(pool_);
        address token_ = configuredPool.token();
        address treasury_ = configuredPool.treasury();
        if (token_ == address(0) || treasury_ == address(0)) revert BadConfig();
        pool = configuredPool;
        token = IMarketV2Token(token_);
        treasury = treasury_;
        feeBps = feeBps_;
    }

    receive() external payable {
        if (msg.sender != address(pool)) revert UnexpectedPayment();
    }

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    function orders(uint256 orderId) external view returns (Order memory) {
        if (orderId >= _orders.length) revert WrongOrder();
        return _orders[orderId];
    }

    function dust(uint32 asset) public pure returns (uint64) {
        if (asset == TOKEN_ASSET) return TOKEN_DUST;
        if (asset == NATIVE) return DUST_NATIVE;
        revert BadAsset();
    }

    function dustSx() external pure returns (uint64) {
        return TOKEN_DUST;
    }

    function feeOf(uint64 pay) public view returns (uint64) {
        return uint64(uint256(pay) * feeBps / 10_000);
    }

    function placeData(Place calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(p.buyAmount, p.maker));
    }

    function fillData(FillPrivate calldata f) public pure returns (bytes32) {
        return keccak256(abi.encode(f.orderId, f.pay, f.outInner, keccak256(f.outCiphertext)));
    }

    function sweepData(Sweep calldata s) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                s.orderIds,
                s.pays,
                s.minBought,
                s.boughtInner,
                keccak256(s.boughtCiphertext),
                s.restInner,
                keccak256(s.restCiphertext)
            )
        );
    }

    function buyFor(uint256 orderId, uint64 pay) external view returns (uint256) {
        if (orderId >= _orders.length) revert WrongOrder();
        Order storage order = _orders[orderId];
        return uint256(pay) * order.sellAmount / order.buyAmount;
    }

    function placeOrder(
        bytes calldata proof,
        IProtocol404Core.TxPublic calldata pub,
        IProtocol404Core.ExtData calldata ext,
        Place calldata p
    ) external nonReentrant returns (uint256 orderId) {
        _checkExtension(ext, placeData(p));
        if (pub.asset > NATIVE) revert BadAsset();
        uint32 buyAsset = 1 - pub.asset;
        if (pub.publicOut <= dust(pub.asset) || p.buyAmount <= dust(buyAsset) || p.buyAmount > MAX_BUY || p.maker == address(0)) {
            revert BadAmount();
        }

        orderId = _orders.length;
        _orders.push(Order(pub.asset, true, 0, p.maker, pub.publicOut, p.buyAmount, pub.publicOut, 0));
        emit OrderPlaced(orderId, p.maker, pub.asset, pub.publicOut, p.buyAmount);
        pool.transact(proof, pub, ext);
    }

    function fillPrivate(
        bytes calldata proof,
        IProtocol404Core.TxPublic calldata pub,
        IProtocol404Core.ExtData calldata ext,
        FillPrivate calldata f
    ) external nonReentrant {
        _checkExtension(ext, fillData(f));
        Order storage order = _openOrder(f.orderId);
        uint64 sideFee = feeOf(f.pay);
        uint64 required = _add64(f.pay, sideFee);
        if (pub.asset != 1 - order.sellAsset || pub.publicOut != required) revert WrongPayment();

        uint64 bought = _fill(order, f.pay, sideFee);
        emit OrderFilled(f.orderId, f.pay, bought, _double64(sideFee), true);
        pool.transact(proof, pub, ext);
        _depositToPool(order.sellAsset, bought, f.outInner, f.outCiphertext);
    }

    function fillPublic(uint256 orderId, uint64 pay, address to) external payable nonReentrant returns (uint64 bought) {
        if (to == address(0)) revert MissingRecipient();
        Order storage order = _openOrder(orderId);
        uint64 sideFee = feeOf(pay);
        uint64 required = _add64(pay, sideFee);
        uint32 paymentAsset = 1 - order.sellAsset;

        if (paymentAsset == NATIVE) {
            if (msg.value != uint256(required) * NATIVE_UNIT) revert WrongPayment();
        } else {
            if (msg.value != 0) revert WrongPayment();
            _safeTransferFrom(address(token), msg.sender, address(this), required);
        }

        bought = _fill(order, pay, sideFee);
        emit OrderFilled(orderId, pay, bought, _double64(sideFee), false);
        _payout(order.sellAsset, to, bought);
    }

    function sweepPrivate(
        bytes calldata proof,
        IProtocol404Core.TxPublic calldata pub,
        IProtocol404Core.ExtData calldata ext,
        Sweep calldata s
    ) external nonReentrant {
        uint256 length = s.orderIds.length;
        if (length == 0 || length > 20 || length != s.pays.length || s.minBought == 0) revert BadAmount();
        _checkExtension(ext, sweepData(s));
        if (pub.asset != NATIVE) revert BadAsset();

        uint256 totalCost;
        uint256 totalBought;
        for (uint256 i; i < length; ++i) {
            uint256 orderId = s.orderIds[i];
            for (uint256 j; j < i; ++j) {
                if (s.orderIds[j] == orderId) revert DuplicateOrder();
            }
            Order storage order = _openOrder(orderId);
            if (order.sellAsset != TOKEN_ASSET) revert BadAsset();
            uint64 pay = s.pays[i];
            uint64 sideFee = feeOf(pay);
            uint64 bought = _fill(order, pay, sideFee);
            totalCost += uint256(pay) + sideFee;
            totalBought += bought;
            emit OrderFilled(orderId, pay, bought, _double64(sideFee), true);
        }
        if (totalBought < s.minBought || totalBought > type(uint64).max || totalCost > pub.publicOut) revert BadAmount();

        pool.transact(proof, pub, ext);
        _depositToPool(TOKEN_ASSET, uint64(totalBought), s.boughtInner, s.boughtCiphertext);
        uint256 refund = uint256(pub.publicOut) - totalCost;
        if (refund != 0) {
            _depositToPool(NATIVE, uint64(refund), s.restInner, s.restCiphertext);
        }
    }

    function release(uint8 action, Release calldata r, bytes calldata signature) external nonReentrant {
        if (action > CANCEL || r.orderId >= _orders.length) revert WrongOrder();
        if (block.timestamp > r.deadline) revert Expired();
        if ((r.fee == 0 && r.relayer != address(0)) || (r.fee != 0 && r.relayer == address(0))) revert BadAmount();

        Order storage order = _orders[r.orderId];
        bytes32 structHash = keccak256(
            abi.encode(
                RELEASE_TYPEHASH,
                action,
                r.orderId,
                r.inner,
                keccak256(r.ciphertext),
                r.relayer,
                r.fee,
                r.deadline,
                order.releases
            )
        );
        address signer = _recover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)), signature);
        if (signer != order.maker) revert BadSignature();

        uint64 amount;
        uint32 asset;
        if (action == CLAIM) {
            amount = order.proceeds;
            order.proceeds = 0;
            asset = 1 - order.sellAsset;
        } else {
            amount = order.remaining;
            order.remaining = 0;
            order.open = false;
            asset = order.sellAsset;
        }
        if (amount <= r.fee) revert NothingToRelease();
        order.releases++;

        emit OrderReleased(r.orderId, action, amount, r.fee);
        if (r.fee != 0) _payout(asset, r.relayer, r.fee);
        _depositToPool(asset, amount - r.fee, r.inner, r.ciphertext);
    }

    function sweepFees() external nonReentrant {
        uint256 tokenFees = feesOwed[TOKEN_ASSET];
        uint256 nativeFees = feesOwed[NATIVE];
        feesOwed[TOKEN_ASSET] = 0;
        feesOwed[NATIVE] = 0;
        if (tokenFees != 0) _safeTransfer(address(token), treasury, tokenFees);
        if (nativeFees != 0) _sendNative(treasury, nativeFees * NATIVE_UNIT);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function eip712Domain()
        external
        view
        returns (bytes1 fields, string memory name, string memory version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] memory extensions)
    {
        return (hex"0f", "404 Market", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function _openOrder(uint256 orderId) private view returns (Order storage order) {
        if (orderId >= _orders.length) revert WrongOrder();
        order = _orders[orderId];
        if (!order.open) revert Closed();
    }

    function _fill(Order storage order, uint64 pay, uint64 sideFee) private returns (uint64 bought) {
        if (pay == 0) revert BadAmount();
        uint256 quoted = uint256(pay) * order.sellAmount / order.buyAmount;
        if (quoted == 0) revert BadAmount();
        if (quoted > order.remaining || quoted > type(uint64).max) revert TooMuch();
        bought = uint64(quoted);
        uint64 nextRemaining = order.remaining - bought;
        if (nextRemaining != 0 && nextRemaining <= dust(order.sellAsset)) revert LeavesDust();
        if (pay <= sideFee) revert BadAmount();
        uint64 makerAmount = pay - sideFee;
        if (uint256(order.proceeds) + makerAmount > type(uint64).max) revert BadAmount();
        order.remaining = nextRemaining;
        order.proceeds += makerAmount;
        if (nextRemaining == 0) order.open = false;
        feesOwed[1 - order.sellAsset] += uint256(sideFee) * 2;
    }

    function _checkExtension(IProtocol404Core.ExtData calldata ext, bytes32 expectedData) private view {
        if (ext.caller != address(this) || ext.recipient != address(this) || ext.data != expectedData) revert WrongOrder();
    }

    function _depositToPool(uint32 asset, uint64 amount, uint256 inner, bytes calldata ciphertext) private {
        if (asset == NATIVE) {
            pool.shield{value: uint256(amount) * NATIVE_UNIT}(asset, amount, inner, ciphertext);
        } else {
            pool.shield(asset, amount, inner, ciphertext);
        }
    }

    function _payout(uint32 asset, address to, uint64 amount) private {
        if (asset == NATIVE) _sendNative(to, uint256(amount) * NATIVE_UNIT);
        else _safeTransfer(address(token), to, amount);
    }

    function _safeTransfer(address target, address to, uint256 amount) private {
        (bool ok, bytes memory result) = target.call(abi.encodeCall(IMarketV2Token.transfer, (to, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address target, address from, address to, uint256 amount) private {
        (bool ok, bytes memory result) = target.call(abi.encodeCall(IMarketV2Token.transferFrom, (from, to, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert TransferFailed();
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_N || (v != 27 && v != 28)) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }

    function _add64(uint64 a, uint64 b) private pure returns (uint64) {
        uint256 sum = uint256(a) + b;
        if (sum > type(uint64).max) revert BadAmount();
        return uint64(sum);
    }

    function _double64(uint64 value) private pure returns (uint64) {
        if (value > type(uint64).max / 2) revert BadAmount();
        return value * 2;
    }
}
