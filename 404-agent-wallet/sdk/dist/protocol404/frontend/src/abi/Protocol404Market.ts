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
    "name": "BadAmount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadAsset",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadConfig",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Closed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Expired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidShortString",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LeavesDust",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MissingRecipient",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MissingRelayer",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NothingToRelease",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ReentrancyGuardReentrantCall",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "str",
        "type": "string"
      }
    ],
    "name": "StringTooLong",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TooMuch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransferFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnexpectedPayment",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongOrder",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongPayment",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [],
    "name": "EIP712DomainChanged",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "paid",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "bought",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "bool",
        "name": "shielded",
        "type": "bool"
      }
    ],
    "name": "OrderFilled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "sellAsset",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "sellAmount",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "buyAmount",
        "type": "uint64"
      }
    ],
    "name": "OrderPlaced",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "action",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "amount",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "fee",
        "type": "uint64"
      }
    ],
    "name": "OrderReleased",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "CANCEL",
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
    "inputs": [],
    "name": "CLAIM",
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
    "inputs": [],
    "name": "DOMAIN_SEPARATOR",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "DUST_NATIVE",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_BUY",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
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
    "inputs": [],
    "name": "NATIVE_UNIT",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "RELEASE_TYPEHASH",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "TOKEN_ASSET",
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
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      },
      {
        "internalType": "uint64",
        "name": "pay",
        "type": "uint64"
      }
    ],
    "name": "buyFor",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "asset",
        "type": "uint8"
      }
    ],
    "name": "dust",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "dustSx",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "eip712Domain",
    "outputs": [
      {
        "internalType": "bytes1",
        "name": "fields",
        "type": "bytes1"
      },
      {
        "internalType": "string",
        "name": "name",
        "type": "string"
      },
      {
        "internalType": "string",
        "name": "version",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "chainId",
        "type": "uint256"
      },
      {
        "internalType": "address",
        "name": "verifyingContract",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "salt",
        "type": "bytes32"
      },
      {
        "internalType": "uint256[]",
        "name": "extensions",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "orderId",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "outInner",
            "type": "uint256"
          },
          {
            "internalType": "bytes",
            "name": "outCiphertext",
            "type": "bytes"
          }
        ],
        "internalType": "struct Protocol404Market.Fill",
        "name": "f",
        "type": "tuple"
      }
    ],
    "name": "fillData",
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
        "components": [
          {
            "internalType": "uint256",
            "name": "orderId",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "outInner",
            "type": "uint256"
          },
          {
            "internalType": "bytes",
            "name": "outCiphertext",
            "type": "bytes"
          }
        ],
        "internalType": "struct Protocol404Market.Fill",
        "name": "f",
        "type": "tuple"
      }
    ],
    "name": "fillPrivate",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      },
      {
        "internalType": "uint64",
        "name": "pay",
        "type": "uint64"
      },
      {
        "internalType": "address",
        "name": "to",
        "type": "address"
      }
    ],
    "name": "fillPublic",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "bought",
        "type": "uint64"
      }
    ],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "orderCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      }
    ],
    "name": "orders",
    "outputs": [
      {
        "components": [
          {
            "internalType": "uint8",
            "name": "sellAsset",
            "type": "uint8"
          },
          {
            "internalType": "bool",
            "name": "open",
            "type": "bool"
          },
          {
            "internalType": "uint32",
            "name": "releases",
            "type": "uint32"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "sellAmount",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "buyAmount",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "remaining",
            "type": "uint64"
          },
          {
            "internalType": "uint64",
            "name": "proceeds",
            "type": "uint64"
          }
        ],
        "internalType": "struct Protocol404Market.Order",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "uint64",
            "name": "buyAmount",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          }
        ],
        "internalType": "struct Protocol404Market.Place",
        "name": "p",
        "type": "tuple"
      }
    ],
    "name": "placeData",
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
        "components": [
          {
            "internalType": "uint64",
            "name": "buyAmount",
            "type": "uint64"
          },
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          }
        ],
        "internalType": "struct Protocol404Market.Place",
        "name": "p",
        "type": "tuple"
      }
    ],
    "name": "placeOrder",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "orderId",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
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
        "internalType": "uint8",
        "name": "action",
        "type": "uint8"
      },
      {
        "components": [
          {
            "internalType": "uint256",
            "name": "orderId",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "inner",
            "type": "uint256"
          },
          {
            "internalType": "bytes",
            "name": "ciphertext",
            "type": "bytes"
          },
          {
            "internalType": "address",
            "name": "relayer",
            "type": "address"
          },
          {
            "internalType": "uint64",
            "name": "fee",
            "type": "uint64"
          },
          {
            "internalType": "uint256",
            "name": "deadline",
            "type": "uint256"
          }
        ],
        "internalType": "struct Protocol404Market.Release",
        "name": "r",
        "type": "tuple"
      },
      {
        "internalType": "bytes",
        "name": "signature",
        "type": "bytes"
      }
    ],
    "name": "release",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "token",
    "outputs": [
      {
        "internalType": "contract IERC20",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "stateMutability": "payable",
    "type": "receive"
  }
] as const;
export default abi;
