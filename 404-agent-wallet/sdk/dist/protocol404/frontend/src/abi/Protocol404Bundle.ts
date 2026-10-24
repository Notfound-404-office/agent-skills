/** @orig index-CVtw0LZh.js:22495 dE Generated ABI; use scripts/extract-reference.py. */
const abi = [
  {
    "inputs": [
      {
        "internalType": "contract Protocol404Pool",
        "name": "pool_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "BadConfig",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReentrancyGuardReentrantCall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongAction",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongFee",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NATIVE",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "call",
        "type": "bytes"
      }
    ],
    "name": "actionData",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "pool",
    "outputs": [
      {
        "internalType": "contract Protocol404Pool",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes",
        "name": "proof",
        "type": "bytes"
      },
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "root",
            "type": "uint256"
          },
          {
            "internalType": "uint256[2]",
            "name": "nullifiers",
            "type": "uint256[2]"
          },
          {
            "internalType": "uint256[2]",
            "name": "commitments",
            "type": "uint256[2]"
          },
          {
            "internalType": "uint64",
            "name": "nowTs",
            "type": "uint64"
          },
          {
            "internalType": "uint8",
            "name": "asset",
            "type": "uint8"
          },
          {
            "internalType": "uint64",
            "name": "publicOut",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "fee",
            "type": "uint64"
          }
        ],
        "internalType": "struct Protocol404Pool.TxPublic",
        "name": "pub",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "recipient",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "relayer",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "caller",
            "type": "address"
          },
          {
            "internalType": "bytes32",
            "name": "data",
            "type": "bytes32"
          },
          {
            "internalType": "bytes[2]",
            "name": "ciphertexts",
            "type": "bytes[2]"
          }
        ],
        "internalType": "struct Protocol404Pool.ExtData",
        "name": "ext",
        "type": "tuple"
      },
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      },
      {
        "internalType": "bytes",
        "name": "call",
        "type": "bytes"
      }
    ],
    "name": "relay",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
export default abi;
