import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

// Constants
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const CACHE_FILE = path.join(__dirname, "../cache/raydium_pools_test.json");
const CACHE_MAX_AGE = 60 * 60 * 1000; // 1 heure en millisecondes

// Types
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

async function isCacheValid(): Promise<boolean> {
    try {
        if (!fs.existsSync(CACHE_FILE)) return false;
        
        const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        const cacheAge = Date.now() - cacheData.timestamp;
        
        return cacheAge < CACHE_MAX_AGE;
    } catch (error) {
        return false;
    }
}

async function readCache(): Promise<any[]> {
    try {
        const cacheData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        if (cacheData && cacheData.pools) {
            return cacheData.pools;
        }
    } catch (error) {
        console.error("Erreur lors de la lecture du cache:", error);
    }
    return [];
}

async function fetchRaydiumPools(): Promise<any[]> {
    try {
        console.log("Téléchargement des données Raydium...");
        const response = await axios.get('https://api.raydium.io/v2/main/pairs', {
            responseType: 'json',
            timeout: 60000
        });

        if (!response.data) {
            throw new Error("Format de réponse invalide");
        }

        // Sauvegarder dans le cache
        const cacheDir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheData = {
            timestamp: Date.now(),
            pools: response.data
        };
        
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheData, null, 2));
        console.log("Cache mis à jour avec succès");
        return response.data;

    } catch (error) {
        console.error("Erreur lors du téléchargement des pools Raydium:", error);
        // En cas d'erreur seulement, on utilise le cache
        console.log("Erreur de fetch, utilisation du cache comme fallback...");
        return await readCache();
    }
}

async function fetchPools(connection: Connection) {
    try {
        console.log("\nRécupération des pools depuis Raydium...");
        const pools = await fetchRaydiumPools();
        
        if (!Array.isArray(pools)) {
            throw new Error("Les données des pools ne sont pas dans le bon format");
        }
        
        console.log(`Nombre total de pools Raydium: ${pools.length}`);
        
        // Filtrer et formater les pools SOL/USDC
        const formattedPools = pools
            .filter(pool => {
                if (!pool || !pool.baseMint || !pool.quoteMint) {
                    return false;
                }
                return (
                    (pool.baseMint === NATIVE_MINT.toString() && pool.quoteMint === USDC_MINT.toString()) ||
                    (pool.quoteMint === NATIVE_MINT.toString() && pool.baseMint === USDC_MINT.toString())
                );
            })
            .map(pool => {
                const isSolBase = pool.baseMint === NATIVE_MINT.toString();
                const price = parseFloat(pool.price || "0");
                const normalizedPrice = isSolBase ? price : 1/price;

                return {
                    id: pool.ammId,
                    name: `SOL/USDC`,
                    tokenA: pool.baseMint,
                    tokenB: pool.quoteMint,
                    price: normalizedPrice,
                    liquidity: parseFloat(pool.liquidity || "0"),
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

        // Afficher les informations des pools
        console.log(`\n${formattedPools.length} pools SOL/USDC trouvées :`);
        
        for (const pool of formattedPools) {
            try {
                console.log(`\nPool ${pool.id}`);
                console.log(`  Prix: ${pool.price.toFixed(3)} USDC/SOL`);
                console.log(`  Liquidité: $${pool.liquidity.toLocaleString()}`);
                
                // Récupérer les informations de la pool
                const poolInfo = await connection.getAccountInfo(new PublicKey(pool.id));
                if (poolInfo) {
                    console.log(`  Taille du compte: ${poolInfo.data.length} bytes`);
                }
            } catch (error) {
                console.error(`Erreur lors de l'affichage des infos pour la pool ${pool.id}:`, error);
            }
        }

        return formattedPools;

    } catch (error) {
        console.error("Erreur lors de la récupération des pools:", error);
        return [];
    }
}

async function main() {
    try {
        // Configuration
        const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
        console.log(`\nConnexion au RPC: ${RPC_ENDPOINT}`);
        
        const connection = new Connection(RPC_ENDPOINT, {
            commitment: 'confirmed',
            confirmTransactionInitialTimeout: 120000, // 2 minutes
            httpHeaders: {
                'Content-Type': 'application/json',
            }
        });

        // Tester la connexion
        console.log("Test de la connexion...");
        try {
            const blockHeight = await connection.getBlockHeight();
            console.log(`Connexion établie. Block height: ${blockHeight}`);
        } catch (error) {
            console.error("Erreur de connexion au RPC:", error);
            throw error;
        }

        await fetchPools(connection);
    } catch (error) {
        console.error("Erreur:", error);
        process.exit(1);
    }
}

main();