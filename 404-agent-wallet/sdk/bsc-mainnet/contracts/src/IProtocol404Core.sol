// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IProtocol404Hasher {
    function hash2(uint256 x, uint256 y) external view returns (uint256);
    function hash3(uint256 x, uint256 y, uint256 z) external view returns (uint256);
    function hash4(uint256 x, uint256 y, uint256 z, uint256 w) external view returns (uint256);
}

interface IProtocol404Verifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}

interface IProtocol404Token {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface IProtocol404Core {
    struct TxPublic {
        uint256 root;
        uint256[2] nullifiers;
        uint256[2] commitments;
        uint64 nowTs;
        uint32 asset;
        uint64 publicOut;
        uint64 fee;
    }

    struct ExtData {
        address recipient;
        address relayer;
        address caller;
        bytes32 data;
        bytes[2] ciphertexts;
    }

    function transact(bytes calldata proof, TxPublic calldata pub, ExtData calldata ext) external;
    function shield(uint32 asset, uint64 amount, uint256 inner, bytes calldata ciphertext) external payable;
    function mint(uint256[] calldata inners, bytes[] calldata ciphertexts) external payable;

    function ASSET_ID_BITS() external view returns (uint8);
    function NATIVE() external view returns (uint32);
    function NATIVE_UNIT() external view returns (uint256);
    function poolBalance(uint256 asset) external view returns (uint256);
    function currentRoot() external view returns (uint256);
    function token() external view returns (address);
    function mintGate() external view returns (address);
    function price() external view returns (uint256);
    function lot() external view returns (uint64);
    function maxPerTx() external view returns (uint256);
    function treasury() external view returns (address);
}
