import { Connection, PublicKey } from "@solana/web3.js";
import { WSOL_MINT } from '../config.js';
import DLMMPool from "@meteora-ag/dlmm";
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MeteoraPool {
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

const CACHE_FILE = path.join(__dirname, '../../cache/meteora-pools.json');

export async function updateMeteoraPoolsCache() {
    try {
        // Fetch latest data from Meteora API
        const response = await fetch('https://dlmm-api.meteora.ag/pair/all');
        const pairs = await response.json();

        // Filter and map SOL pools with correct structure
        const solPairs = pairs
            .filter((pair: any) => 
                // Check SOL pairs and minimum liquidity ($1000)
                (pair.mint_x === WSOL_MINT || pair.mint_y === WSOL_MINT) &&
                Number(pair.liquidity) >= 1000
            )
            .map((pair: any) => {
                const isSolBase = pair.mint_y === WSOL_MINT;
                const rawPrice = Number(pair.current_price);
                
                // If SOL is tokenA (base), use raw price directly
                // If SOL is tokenB (quote), invert the price
                const price = isSolBase ? rawPrice : (1 / rawPrice);

                return {
                    id: pair.address,
                    name: pair.name,
                    tokenA: pair.mint_x,
                    tokenB: pair.mint_y,
                    reserveA: Number(pair.reserve_x_amount),
                    reserveB: Number(pair.reserve_y_amount),
                    liquidity: Number(pair.liquidity),
                    volume24h: Number(pair.trade_volume_24h),
                    fees24h: Number(pair.fees_24h),
                    price
                };
            });

        // Write to cache file
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            timestamp: Date.now(),
            pools: solPairs
        }, null, 2));
        
        return solPairs;
    } catch (error) {
        console.error('Error updating Meteora pools cache:', error);
        throw error;
    }
}

export async function getMeteoraSolPools(connection: Connection): Promise<MeteoraPool[]> {
    let pools: MeteoraPool[] = [];

    try {
        // Load pools from cache
        if (fs.existsSync(CACHE_FILE)) {
            const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            pools = cacheData.pools;
        }

        // If no pools in cache, update cache
        if (pools.length === 0) {
            pools = await updateMeteoraPoolsCache();
        }

        // Update cache
        console.log(`Refreshing Meteora pools cache...`);
        pools = await updateMeteoraPoolsCache();

        return pools;

    } catch (error) {
        console.error('Error with Meteora pools:', error);
        throw error;
    }
}