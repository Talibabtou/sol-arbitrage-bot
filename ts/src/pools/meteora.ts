import { Connection } from "@solana/web3.js";
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { WSOL_MINT } from '../config.js';

const CACHE_FILE = path.join(process.cwd(), 'cache', 'meteora_pools.json');

interface MeteoraPool {
    id: string;
    name: string;
    tokenA: string;
    tokenB: string;
    price: number;
    liquidity: number;
    isSolBase: boolean;
}

async function fetchMeteoraPoolsData(): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'dlmm-api.meteora.ag',
            path: '/pair/all',
            method: 'GET',
            headers: {
                'Accept': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const jsonData = JSON.parse(Buffer.concat(chunks).toString());
                    resolve(jsonData);
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

function normalizePoolName(name: string, isFirstTokenSol: boolean): string {
    const [token1, token2] = name.split('-');
    // Si SOL est le premier token, on inverse pour avoir le format WSOL/XXX
    if (isFirstTokenSol) {
        return `WSOL/${token2}`;
    }
    // Si SOL est le deuxième token, on met WSOL en premier
    return `WSOL/${token1}`;
}

export async function getMeteoraSolPools(connection: Connection): Promise<MeteoraPool[]> {
    try {
        console.log("Récupération des pools Meteora...");
        const meteoraPairs = await fetchMeteoraPoolsData();
        console.log(`Nombre total de pairs Meteora: ${meteoraPairs.length}`);
        
        // Filtrer et formater les pools SOL
        const formattedPools = meteoraPairs
            .filter(pool => 
                (pool.mint_x === WSOL_MINT || pool.mint_y === WSOL_MINT) &&
                Number(pool.liquidity) >= 5000
            )
            .map(pool => {
                const [token1, token2] = pool.name.split('-');
                const isFirstTokenSol = token1.includes('SOL');
                const price = Number(pool.current_price);
                // Normaliser pour avoir toujours 1 SOL = X tokens
                const normalizedPrice = isFirstTokenSol ? price : 1/price;

                return {
                    id: pool.address,
                    name: normalizePoolName(pool.name, isFirstTokenSol),
                    tokenA: pool.mint_x,
                    tokenB: pool.mint_y,
                    price: normalizedPrice, // Prix normalisé: 1 SOL = X tokens
                    liquidity: Number(pool.liquidity),
                    isSolBase: isFirstTokenSol
                };
            });

        console.log(`Nombre de pools SOL Meteora trouvés: ${formattedPools.length}`);

        // Sauvegarder dans le cache (écrase l'ancien)
        const cacheDir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        
        const cacheData = {
            timestamp: Date.now(),
            pools: formattedPools
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));

        return formattedPools;

    } catch (error) {
        console.error("Erreur Meteora:", error);
        return [];
    }
}