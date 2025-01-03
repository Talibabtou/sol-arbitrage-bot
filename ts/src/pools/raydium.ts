import { Connection } from "@solana/web3.js";
import axios from 'axios';
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
    ammId: string;
    ammAuthority: string;
    ammOpenOrders: string;
    ammTargetOrders: string;
    poolCoinTokenAccount: string;
    poolPcTokenAccount: string;
    serumProgramId: string;
    serumMarket: string;
    serumBids: string;
    serumAsks: string;
    serumEventQueue: string;
    serumCoinVaultAccount: string;
    serumPcVaultAccount: string;
    serumVaultSigner: string;
}

async function fetchRaydiumPools(): Promise<any[]> {
    try {
        console.log("Téléchargement des données Raydium...");
        const response = await axios.get('https://api.raydium.io/v2/main/pairs', {
            responseType: 'json',
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            decompress: true,
            timeout: 60000 // 60 secondes de timeout
        });

        if (!response.data) {
            throw new Error("Format de réponse invalide");
        }

        return response.data;
    } catch (error) {
        console.error("Erreur lors du téléchargement des pools Raydium:", error);
        throw error;
    }
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
        
        if (!Array.isArray(pairs)) {
            throw new Error("Les données des pools ne sont pas dans le bon format");
        }
        
        console.log(`Nombre total de pairs Raydium: ${pairs.length}`);
        
        // Filtrer et formater les pools SOL
        const formattedPools = pairs
            .filter(pool => {
                if (!pool || !pool.baseMint || !pool.quoteMint || !pool.liquidity) {
                    return false;
                }
                const containsSol = pool.baseMint === WSOL_MINT || pool.quoteMint === WSOL_MINT;
                const hasSignificantLiquidity = parseFloat(pool.liquidity) > 5000;
                return containsSol && hasSignificantLiquidity;
            })
            .map(pool => {
                const isSolBase = pool.baseMint === WSOL_MINT;
                const price = parseFloat(pool.price || "0");
                // Normaliser pour avoir toujours 1 SOL = X tokens
                const normalizedPrice = isSolBase ? price : 1/price;

                return {
                    id: pool.ammId,
                    name: normalizePoolName(pool.name, isSolBase),
                    tokenA: pool.baseMint,
                    tokenB: pool.quoteMint,
                    price: normalizedPrice,
                    liquidity: parseFloat(pool.liquidity),
                    isSolBase,
                    // Informations pour le swap
                    ammId: pool.ammId,
                    ammAuthority: pool.ammAuthority,
                    ammOpenOrders: pool.ammOpenOrders,
                    ammTargetOrders: pool.ammTargetOrders,
                    poolCoinTokenAccount: pool.poolCoinTokenAccount,
                    poolPcTokenAccount: pool.poolPcTokenAccount,
                    serumProgramId: pool.serumProgramId,
                    serumMarket: pool.serumMarket,
                    serumBids: pool.serumBids,
                    serumAsks: pool.serumAsks,
                    serumEventQueue: pool.serumEventQueue,
                    serumCoinVaultAccount: pool.serumCoinVaultAccount,
                    serumPcVaultAccount: pool.serumPcVaultAccount,
                    serumVaultSigner: pool.serumVaultSigner
                };
            });

        console.log(`Nombre de pools SOL Raydium trouvés: ${formattedPools.length}`);

        // Sauvegarder dans le cache
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
        // En cas d'erreur, essayer de charger depuis le cache
        try {
            if (fs.existsSync(CACHE_FILE)) {
                console.log("Utilisation du cache Raydium comme fallback...");
                const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
                return cacheData.pools;
            }
        } catch (cacheError) {
            console.error("Erreur lors de la lecture du cache:", cacheError);
        }
        return [];
    }
}