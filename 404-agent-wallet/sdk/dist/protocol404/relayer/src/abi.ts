/** Minimal original contract ABI surface used by the relayer. */

const historicalProtocol404PoolAbi = [
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
      }
    ],
    "name": "transact",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

const historicalProtocol404MarketAbi = [
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
  }
] as const;

/** MarketV2 keeps the V1 surface and overloads private fill with an explicit payment. */
const historicalProtocol404MarketV2Abi = [
  ...historicalProtocol404MarketAbi,
  {
    type: "function", name: "fillPrivate", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "pub", type: "tuple", components: [
        { name: "root", type: "uint256" }, { name: "nullifiers", type: "uint256[2]" },
        { name: "commitments", type: "uint256[2]" }, { name: "nowTs", type: "uint64" },
        { name: "asset", type: "uint8" }, { name: "publicOut", type: "uint64" }, { name: "fee", type: "uint64" },
      ] },
      { name: "ext", type: "tuple", components: [
        { name: "recipient", type: "address" }, { name: "relayer", type: "address" },
        { name: "caller", type: "address" }, { name: "data", type: "bytes32" }, { name: "ciphertexts", type: "bytes[2]" },
      ] },
      { name: "f", type: "tuple", components: [
        { name: "orderId", type: "uint256" }, { name: "pay", type: "uint64" },
        { name: "outInner", type: "uint256" }, { name: "outCiphertext", type: "bytes" },
      ] },
    ],
  },
  {
    type: "function", name: "sweepPrivate", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "pub", type: "tuple", components: [
        { name: "root", type: "uint256" }, { name: "nullifiers", type: "uint256[2]" },
        { name: "commitments", type: "uint256[2]" }, { name: "nowTs", type: "uint64" },
        { name: "asset", type: "uint8" }, { name: "publicOut", type: "uint64" }, { name: "fee", type: "uint64" },
      ] },
      { name: "ext", type: "tuple", components: [
        { name: "recipient", type: "address" }, { name: "relayer", type: "address" },
        { name: "caller", type: "address" }, { name: "data", type: "bytes32" }, { name: "ciphertexts", type: "bytes[2]" },
      ] },
      { name: "s", type: "tuple", components: [
        { name: "orderIds", type: "uint256[]" }, { name: "pays", type: "uint64[]" }, { name: "minBought", type: "uint64" },
        { name: "boughtInner", type: "uint256" }, { name: "boughtCiphertext", type: "bytes" },
        { name: "restInner", type: "uint256" }, { name: "restCiphertext", type: "bytes" },
      ] },
    ],
  },
] as const;

const historicalProtocol404MintAbi = [
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
  }
] as const;

const historicalProtocol404BundleAbi = [
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

type AbiNode = { name?: string; type?: string; internalType?: string; inputs?: readonly AbiNode[]; outputs?: readonly AbiNode[]; components?: readonly AbiNode[] };

function u32AssetAbi<T>(value: T): T {
  if (Array.isArray(value)) return value.map(u32AssetAbi) as T;
  if (!value || typeof value !== "object") return value;
  const node = value as AbiNode;
  const converted = node.type === "uint8" && ["asset", "assetIn", "sellAsset"].includes(node.name ?? "");
  const outputs = node.type === "function" && ["NATIVE", "TOKEN_ASSET"].includes(node.name ?? "")
    ? node.outputs?.map(output => output.type === "uint8" ? { ...output, type: "uint32", internalType: output.internalType === "uint8" ? "uint32" : output.internalType } : output)
    : node.outputs;
  return {
    ...node,
    ...(converted ? { type: "uint32", internalType: node.internalType === "uint8" ? "uint32" : node.internalType } : {}),
    ...(node.inputs ? { inputs: u32AssetAbi(node.inputs) } : {}),
    ...(outputs ? { outputs: u32AssetAbi(outputs) } : {}),
    ...(node.components ? { components: u32AssetAbi(node.components) } : {}),
  } as T;
}

const assetIdBits = { type: "function", name: "ASSET_ID_BITS", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] } as const;
export const protocol404PoolAbi = [...u32AssetAbi(historicalProtocol404PoolAbi), assetIdBits] as const;
export const protocol404MarketAbi = u32AssetAbi(historicalProtocol404MarketAbi);
export const protocol404MarketV2Abi = u32AssetAbi(historicalProtocol404MarketV2Abi);
export const protocol404MintAbi = u32AssetAbi(historicalProtocol404MintAbi);
export const protocol404BundleAbi = u32AssetAbi(historicalProtocol404BundleAbi);
