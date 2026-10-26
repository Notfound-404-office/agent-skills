/** ABI for the maintained source-core Protocol404Mint deployment. */
const abi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "pool_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "membershipNft_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "BadPool",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BadPoolTemplate",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "MintLimit",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotMember",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OneMintPerTransaction",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnexpectedPayment",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongMint",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "WrongPayment",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "submitter",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "totalMinted",
        "type": "uint256"
      }
    ],
    "name": "PrivateMint",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "membershipNft",
    "outputs": [
      {
        "internalType": "contract IProtocol404Membership",
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
        "internalType": "uint256[]",
        "name": "inners",
        "type": "uint256[]"
      },
      {
        "internalType": "bytes[]",
        "name": "ciphertexts",
        "type": "bytes[]"
      }
    ],
    "name": "mintData",
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
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "mintedBy",
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
    "name": "pool",
    "outputs": [
      {
        "internalType": "contract IProtocol404Core",
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
        "internalType": "struct IProtocol404Core.TxPublic",
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
        "internalType": "struct IProtocol404Core.ExtData",
        "name": "ext",
        "type": "tuple"
      },
      {
        "internalType": "uint256[]",
        "name": "inners",
        "type": "uint256[]"
      },
      {
        "internalType": "bytes[]",
        "name": "ciphertexts",
        "type": "bytes[]"
      }
    ],
    "name": "privateMint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "stateMutability": "payable",
    "type": "receive"
  }
] as const;
export default abi;
