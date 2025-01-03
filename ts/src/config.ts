import { Connection } from "@solana/web3.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import { writeFile } from 'fs/promises';
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

dotenv.config();

// Get current directory path (works with ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Constants
export const MAINNET_JSON_PATH = path.join(PROJECT_ROOT, 'mainnet.json');
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Connection config
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
export const connection = new Connection(
    process.env.RPC_ENDPOINT || DEFAULT_RPC,
    {
        commitment: 'confirmed',
        wsEndpoint: process.env.WS_ENDPOINT
    }
);

// Fast API config
export const FAST_API_KEY = process.env.FAST_API;
if (!FAST_API_KEY) {
    throw new Error("La clé API Fast n'est pas configurée dans le fichier .env");
}

// Wallet config
const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!WALLET_PRIVATE_KEY) {
    throw new Error("La clé privée du wallet n'est pas configurée dans le fichier .env");
}

// Création du Keypair à partir de la clé privée
export const WALLET_KEYPAIR = Keypair.fromSecretKey(
    bs58.decode(WALLET_PRIVATE_KEY)
);

// Raydium API endpoints
export const RAYDIUM_API = {
    POOLS: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
    MAIN: "https://api.raydium.io/v2/main"
};

// Function to download mainnet.json if needed
export async function downloadMainnetJson() {
    try {
        const response = await fetch(RAYDIUM_API.POOLS);
        const rawData = await response.text();
        console.log('Raw API response:', rawData.substring(0, 100));
        const data = JSON.parse(rawData);
        await writeFile(MAINNET_JSON_PATH, JSON.stringify(data, null, 2));
        console.log('Successfully downloaded mainnet.json');
        return data;
    } catch (error) {
        console.error('Error downloading mainnet.json:', error);
        throw error;
    }
}

export const CONFIG = {
    RPC_URL: process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
    WALLET_SECRET_KEY: process.env.WALLET_KEY || "", // Optionnel pour juste lire les pools
    API_HOST: undefined // Par défaut pour mainnet
}
