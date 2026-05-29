import { createPublicClient, createWalletClient, custom, http, defineChain, parseEther, formatEther, type Address } from "viem";

export const RITUAL_CHAIN = defineChain({
  id: 1979,
  name: "Ritual",
  nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.ritualfoundation.org/"] } },
  blockExplorers: { default: { name: "Explorer", url: "https://explorer.ritualfoundation.org/" } },
});

export const CONTRACT_ADDRESS = "0x205336D124145881e00dad29aAA9669F739684B2" as const;
export const DEPLOY_BLOCK = 25286727n;
// Leaderboard reset: only events at or after this Unix timestamp are shown.
// Bump this to wipe the visible leaderboard without redeploying.
export const LEADERBOARD_RESET_AT = 0; // no reset
// Encoding: on-chain `score` arg = realScore * SCORE_ENCODE_BASE + questionsAnswered
export const SCORE_ENCODE_BASE = 100000;
export const MAX_QUESTIONS_ENCODE = SCORE_ENCODE_BASE - 1;
export const FEE_WEI = parseEther("0.0002");
export const QUIZ_ABI = [
  { type: "function", name: "FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "startGame",
    stateMutability: "payable",
    inputs: [{ name: "discord", type: "string" }],
    outputs: [],
  },
  {
    type: "function",
    name: "submitScore",
    stateMutability: "nonpayable",
    inputs: [
      { name: "discord", type: "string" },
      { name: "score", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "GameStarted",
    inputs: [
      { indexed: true, name: "player", type: "address" },
      { indexed: false, name: "discord", type: "string" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "ScoreSubmitted",
    inputs: [
      { indexed: true, name: "player", type: "address" },
      { indexed: false, name: "discord", type: "string" },
      { indexed: false, name: "score", type: "uint256" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
  },
] as const;

export const publicClient = createPublicClient({
  chain: RITUAL_CHAIN,
  transport: http(),
});

export function getWalletClient() {
  if (typeof window === "undefined" || !(window as any).ethereum) {
    throw new Error("No wallet detected. Install MetaMask.");
  }
  return createWalletClient({
    chain: RITUAL_CHAIN,
    transport: custom((window as any).ethereum),
  });
}

export async function ensureRitualChain() {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No wallet");
  const hexId = "0x" + (1979).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (err: any) {
    if (err?.code === 4902 || err?.code === -32603) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: "Ritual",
          rpcUrls: ["https://rpc.ritualfoundation.org/"],
          nativeCurrency: { name: "Ritual", symbol: "RITUAL", decimals: 18 },
          blockExplorers: [{ name: "Explorer", url: "https://explorer.ritualfoundation.org/" }],
        }],
      });
    } else {
      throw err;
    }
  }
}

export async function connectWallet(): Promise<Address> {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No wallet. Install MetaMask.");
  const accounts: string[] = await eth.request({ method: "eth_requestAccounts" });
  await ensureRitualChain();
  return accounts[0] as Address;
}


export type ScoreEntry = {
  player: string;
  discord: string;
  score: number;
  questions: number;
  timestamp: number;
  txHash: string;
};


export function encodeScore(realScore: number, questions: number): bigint {
  const q = Math.max(0, Math.min(MAX_QUESTIONS_ENCODE, Math.floor(questions)));
  return BigInt(Math.floor(realScore)) * BigInt(SCORE_ENCODE_BASE) + BigInt(q);
}

export function decodeScore(encoded: number): { score: number; questions: number } {
  return {
    score: Math.floor(encoded / SCORE_ENCODE_BASE),
    questions: encoded % SCORE_ENCODE_BASE,
  };
}

export async function fetchScores(windowSeconds: number): Promise<ScoreEntry[]> {
  const CHUNK_SIZE = 90000n;
  const latestBlock = await publicClient.getBlockNumber();
  let currentBlock = DEPLOY_BLOCK;
  const allLogs: any[] = [];

  while (currentBlock <= latestBlock) {
    const toBlock = currentBlock + CHUNK_SIZE - 1n < latestBlock
      ? currentBlock + CHUNK_SIZE - 1n
      : latestBlock;

    const chunk = await publicClient.getLogs({
      address: CONTRACT_ADDRESS,
      fromBlock: currentBlock,
      toBlock,
      event: {
        type: "event",
        name: "ScoreSubmitted",
        inputs: [
          { indexed: true, name: "player", type: "address" },
          { indexed: false, name: "discord", type: "string" },
          { indexed: false, name: "score", type: "uint256" },
          { indexed: false, name: "timestamp", type: "uint256" },
        ],
      } as const,
    });

    allLogs.push(...chunk);
    currentBlock = toBlock + 1n;
  }

  const windowCutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  const cutoff = LEADERBOARD_RESET_AT > 0 ? Math.max(windowCutoff, LEADERBOARD_RESET_AT) : windowCutoff;

  const all: ScoreEntry[] = allLogs.map((l) => {
    try {
      const args = l.args as any;
      const encoded = Number(BigInt(args.score));
      const { score, questions } = decodeScore(encoded);
      return {
        player: args.player as string,
        discord: args.discord as string,
        score,
        questions,
        timestamp: Number(BigInt(args.timestamp)),
        txHash: l.transactionHash!,
      };
    } catch (e) {
      return null;
    }
  }).filter(Boolean) as ScoreEntry[];

  console.log("All decoded:", all.length, "cutoff:", cutoff, "samples:", all.slice(0,3).map(e => ({discord: e.discord, timestamp: e.timestamp})));
  const filtered = all.filter((e) => e.timestamp >= cutoff);
  console.log("Filtered:", filtered.length);
  filtered.sort((a, b) => a.timestamp - b.timestamp);
  const map = new Map<string, ScoreEntry>();
  for (const e of filtered) {
    map.set(e.discord.toLowerCase(), e);
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 50);
}