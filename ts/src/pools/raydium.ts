import { Connection } from "@solana/web3.js";
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { WSOL_MINT } from '../config.js';

const CACHE_FILE = path.join(process.cwd(), 'cache', 'raydium_pools.json');

interface RaydiumPool {
    id: string;
    name: string;
    tokenA: string;
    tokenB: string;
    price: number;
    liquidity: number;
    isSolBase: boolean;
}

async function fetchRaydiumPools(): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.raydium.io',
            path: '/v2/main/pairs',
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

function normalizePoolName(name: string, isSolBase: boolean): string {
    const [token1, token2] = name.split('/');
    // Si SOL n'est pas en premier, on inverse pour avoir WSOL en premier
    if (!isSolBase) {
        return `WSOL/${token1}`;
    }
    return name;
}

export async function getRaydiumSolPools(connection: Connection): Promise<RaydiumPool[]> {
    try {
        console.log("Récupération des pools Raydium...");
        const pairs = await fetchRaydiumPools();
        console.log(`Nombre total de pairs Raydium: ${pairs.length}`);
        
        // Filtrer et formater les pools SOL
        const formattedPools = pairs
            .filter(pool => {
                const containsSol = pool.baseMint === WSOL_MINT || pool.quoteMint === WSOL_MINT;
                const hasSignificantLiquidity = parseFloat(pool.liquidity) > 5000;
                return containsSol && hasSignificantLiquidity;
            })
            .map(pool => {
                const isSolBase = pool.baseMint === WSOL_MINT;
                const price = parseFloat(pool.price);
                // Normaliser pour avoir toujours 1 SOL = X tokens
                const normalizedPrice = isSolBase ? price : 1/price;

                return {
                    id: pool.ammId,
                    name: normalizePoolName(pool.name, isSolBase),
                    tokenA: pool.baseMint,
                    tokenB: pool.quoteMint,
                    price: normalizedPrice, // Prix normalisé: 1 SOL = X tokens
                    liquidity: parseFloat(pool.liquidity),
                    isSolBase // Ajouter cette information pour l'analyse
                };
            });

        console.log(`Nombre de pools SOL Raydium trouvés: ${formattedPools.length}`);

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
        console.error("Erreur Raydium:", error);
        return [];
    }
}