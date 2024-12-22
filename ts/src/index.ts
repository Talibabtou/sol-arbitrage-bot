import { connection, WSOL_MINT } from "./config.js";
import { getRaydiumSolPools } from "./pools/raydium.js";
import { getMeteoraSolPools } from "./pools/meteora.js";

// Define interfaces for our pool types
interface RaydiumPool {
    id: string;
    tokenA: string;
    tokenB: string;
    price: number | null;
    reserveA: number;
    reserveB: number;
    liquidity: number;
}

interface MeteoraPool {
    id: string;
    tokenA: string;
    tokenB: string;
    price: number | null;
    reserveA: number;
    reserveB: number;
    liquidity: number;
}

async function findArbitrage() {
    const meteoraPools = await getMeteoraSolPools(connection);
    const raydiumPools = await getRaydiumSolPools(connection);

    // Create maps for quick lookup using non-SOL token as key
    const meteoraPoolMap = new Map<string, MeteoraPool>();
    meteoraPools.forEach(pool => {
        const tokenKey = pool.tokenA === WSOL_MINT ? pool.tokenB : pool.tokenA;
        meteoraPoolMap.set(tokenKey, pool);
    });

    // Only iterate through Raydium pools that have matching Meteora pools
    raydiumPools.forEach(raydiumPool => {
        const tokenKey = raydiumPool.tokenA === WSOL_MINT ? raydiumPool.tokenB : raydiumPool.tokenA;
        const meteoraPool = meteoraPoolMap.get(tokenKey);

        if (meteoraPool && raydiumPool.price && meteoraPool.price) {
            const priceDiff = ((raydiumPool.price - meteoraPool.price) / meteoraPool.price) * 100;
            
            // Minimum reserve thresholds
            const MIN_SOL_RESERVE = 1 * 1e9; // 1 SOL in lamports
            
            // Get SOL reserves for both pools
            const raydiumSolReserve = raydiumPool.tokenA === WSOL_MINT ? 
                raydiumPool.reserveA : raydiumPool.reserveB;
            const meteoraSolReserve = meteoraPool.tokenA === WSOL_MINT ? 
                meteoraPool.reserveA : meteoraPool.reserveB;

            // Check minimum liquidity and reserves
            if (Math.abs(priceDiff) > 1.0 && 
                raydiumPool.liquidity >= 1000 && 
                meteoraPool.liquidity >= 1000 &&
                (raydiumSolReserve >= MIN_SOL_RESERVE / 1e9) &&
                meteoraSolReserve >= MIN_SOL_RESERVE) {
                
                const raydiumTokenAddr = raydiumPool.tokenA === WSOL_MINT ? raydiumPool.tokenB : raydiumPool.tokenA;
                const meteoraTokenAddr = meteoraPool.tokenA === WSOL_MINT ? meteoraPool.tokenB : meteoraPool.tokenA;
                
                console.log(`\nArbitrage opportunity found:`);
                console.log(`Token pair: ${raydiumPool.name}`);
                console.log(`Token addresses:`);
                console.log(`  Raydium: ${raydiumTokenAddr}`);
                console.log(`  Meteora: ${meteoraTokenAddr}`);
                console.log(`Pool IDs:`);
                console.log(`  Raydium: ${raydiumPool.id}`);
                console.log(`  Meteora: ${meteoraPool.id}`);
                console.log(`SOL Reserves:`);
                console.log(`  Raydium: ${(raydiumSolReserve).toFixed(2)} SOL`);
                console.log(`  Meteora: ${(meteoraSolReserve / 1e9).toFixed(2)} SOL`);
                console.log(`Token Reserves:`);
                console.log(`  Raydium: ${raydiumPool.tokenA === WSOL_MINT ? 
                    raydiumPool.reserveB : raydiumPool.reserveA}`);
                console.log(`  Meteora: ${meteoraPool.tokenA === WSOL_MINT ? 
                    (meteoraPool.reserveB / 1e6).toFixed(2) : (meteoraPool.reserveA / 1e6).toFixed(2)}`);
                console.log(`Liquidity:`);
                console.log(`  Raydium: $${raydiumPool.liquidity.toFixed(2)}`);
                console.log(`  Meteora: $${meteoraPool.liquidity.toFixed(2)}`);
                console.log(`Prices:`);
                console.log(`  Raydium: ${raydiumPool.price}`);
                console.log(`  Meteora: ${meteoraPool.price}`);
                console.log(`Difference: ${priceDiff.toFixed(2)}%`);
                
                if (raydiumTokenAddr !== meteoraTokenAddr) {
                    console.log('WARNING: Different token addresses - Not a real arbitrage opportunity!');
                } else if (priceDiff > 0) {
                    console.log('Buy on Meteora, Sell on Raydium');
                } else {
                    console.log('Buy on Raydium, Sell on Meteora');
                }
            }
        }
    });
}

findArbitrage().catch(console.error); 