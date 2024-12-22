import { Connection } from "@solana/web3.js";
import { WSOL_MINT } from '../config.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RaydiumPool {
    id: string;
    name: string;
    tokenA: string;
    tokenB: string;
    reserveA: number;
    reserveB: number;
    liquidity: number;
    volume24h: number;
    fees24h: number;
    price: number | null;
}

const CACHE_FILE = path.join(__dirname, '../../cache/raydium-pools.json');

export async function updateRaydiumPoolsCache() {
    try {
        // First, load Meteora pools to get the list of tokens we're interested in
        const meteoraCacheFile = path.join(__dirname, '../../cache/meteora-pools.json');
        if (!existsSync(meteoraCacheFile)) {
            console.log('No Meteora cache found. Please update Meteora cache first.');
            return [];
        }

        const meteoraCache = JSON.parse(await readFile(meteoraCacheFile, 'utf8'));
        const meteoraTokens = new Set(
            meteoraCache.pools.map((pool: any) => 
                pool.tokenA === WSOL_MINT ? pool.tokenB : pool.tokenA
            )
        );

        const response = await fetch('https://api.raydium.io/v2/main/pairs');
        const pairs = await response.json();

        const solPairs = pairs
            .filter((pool: any) => {
                // Check if it's a SOL pair with minimum liquidity
                const isSolPair = (pool.baseMint === WSOL_MINT || pool.quoteMint === WSOL_MINT);
                const hasLiquidity = Number(pool.liquidity) >= 1000;
                
                // Get the non-SOL token
                const nonSolToken = pool.baseMint === WSOL_MINT ? pool.quoteMint : pool.baseMint;
                
                // Check if this token exists in Meteora pools
                const existsInMeteora = meteoraTokens.has(nonSolToken);

                return isSolPair && hasLiquidity && existsInMeteora;
            })
            .map((pool: any) => {
                const isSolBase = pool.baseMint === WSOL_MINT;
                const rawPrice = Number(pool.price);
                const price = isSolBase ? (1 / rawPrice) : rawPrice;

                return {
                    id: pool.ammId,
                    name: pool.name,
                    tokenA: pool.baseMint,
                    tokenB: pool.quoteMint,
                    reserveA: Number(pool.tokenAmountCoin),
                    reserveB: Number(pool.tokenAmountPc),
                    liquidity: Number(pool.liquidity),
                    volume24h: Number(pool.volume24h),
                    fees24h: Number(pool.fee24h),
                    price
                };
            });

        // Write to cache file
        await writeFile(CACHE_FILE, JSON.stringify({
            timestamp: Date.now(),
            pools: solPairs
        }, null, 2));

        return solPairs;
    } catch (error) {
        console.error('Error updating Raydium pools cache:', error);
        throw error;
    }
}

export async function getRaydiumSolPools(connection: Connection): Promise<RaydiumPool[]> {
    let pools: RaydiumPool[] = [];

    try {
        // Load pools from cache
        if (existsSync(CACHE_FILE)) {
            const cacheData = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
            pools = cacheData.pools;
        }

        // If no pools in cache, update cache
        if (pools.length === 0) {
            pools = await updateRaydiumPoolsCache();
        }

        // Update cache
        console.log(`Refreshing Raydium pools cache...`);
        pools = await updateRaydiumPoolsCache();

        return pools;

    } catch (error) {
        console.error('Error with Raydium pools:', error);
        throw error;
    }
}