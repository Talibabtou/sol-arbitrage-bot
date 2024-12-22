import { Connection } from "@solana/web3.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from 'url';
import { writeFile } from 'fs/promises';

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

// Raydium API endpoints
export const RAYDIUM_API = {
    POOLS: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
    MAIN: "https://api.raydium.io/v2/main"
};

// Function to download mainnet.json if needed
export async function downloadMainnetJson() {
    try {
        const response = await fetch(RAYDIUM_API.POOLS);
        const rawData = await response.text(); // Get raw text first
        console.log('Raw API response:', rawData.substring(0, 100)); // Debug first 100 chars
        const data = JSON.parse(rawData);
        await writeFile(MAINNET_JSON_PATH, JSON.stringify(data, null, 2));
        console.log('Successfully downloaded mainnet.json');
        return data;
    } catch (error) {
        console.error('Error downloading mainnet.json:', error);
        throw error;
    }
}
