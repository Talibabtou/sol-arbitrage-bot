import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as readline from 'readline';
import { executeArbitrage, ArbitrageExecution, saveTop10Cache } from "./arbitrage/executor";
import * as dotenv from "dotenv";
import { connection, WSOL_MINT } from "./config.js";
import { getRaydiumSolPools } from "./pools/raydium.js";
import { getMeteoraSolPools } from "./pools/meteora.js";
import bs58 from "bs58";

dotenv.config();

// Interface pour les pools
interface Pool {
    id: string;
    name: string;
    tokenA: string;
    tokenB: string;
    price: number;
    liquidity: number;
    isSolBase: boolean;
}

// Créer l'interface readline
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Fonction pour obtenir l'autre token que SOL dans une paire
function getNonSolToken(pool: Pool): string {
    return pool.tokenA === WSOL_MINT ? pool.tokenB : pool.tokenA;
}

// Fonction pour trouver les opportunités d'arbitrage
async function findArbitrage(): Promise<{ opportunities: ArbitrageExecution[], meteoraPools: any[], raydiumPools: any[] }> {
    const meteoraPools = await getMeteoraSolPools(connection);
    const raydiumPools = await getRaydiumSolPools(connection);
    const opportunities: ArbitrageExecution[] = [];

    console.log("\nDébut du processus de matching...");

    // Create maps for quick lookup using non-SOL token address as key
    const meteoraPoolMap = new Map<string, Pool>();
    meteoraPools.forEach(pool => {
        const tokenKey = getNonSolToken(pool);
        meteoraPoolMap.set(tokenKey, pool);
    });

    // Parcourir les pools Raydium
    raydiumPools.forEach(raydiumPool => {
        const tokenKey = getNonSolToken(raydiumPool);
        const meteoraPool = meteoraPoolMap.get(tokenKey);

        if (meteoraPool && raydiumPool.price && meteoraPool.price) {
            const priceDiff = ((raydiumPool.price - meteoraPool.price) / Math.min(raydiumPool.price, meteoraPool.price)) * 100;

            // Vérifier les seuils minimums
            if (Math.abs(priceDiff) > 0.5 && Math.abs(priceDiff) < 10.0) {
                const minLiquidity = 1000;
                if (raydiumPool.liquidity >= minLiquidity && meteoraPool.liquidity >= minLiquidity) {
                    opportunities.push({
                        pairName: raydiumPool.name,
                        raydiumPoolId: raydiumPool.id,
                        meteoraPoolId: meteoraPool.id,
                        expectedProfit: Math.abs(priceDiff),
                        amountIn: 0, // Sera défini par l'utilisateur
                        tokenAddress: tokenKey,
                        buyOnMeteora: raydiumPool.price > meteoraPool.price
                    });
                }
            }
        }
    });

    // Trier par profit attendu
    return {
        opportunities: opportunities.sort((a, b) => b.expectedProfit - a.expectedProfit),
        meteoraPools,
        raydiumPools
    };
}

// Fonction pour demander à l'utilisateur de choisir une opportunité
function askForOpportunity(opportunities: ArbitrageExecution[]): Promise<ArbitrageExecution> {
    return new Promise((resolve) => {
        rl.question('\nChoisissez une opportunité (1-10): ', (answer) => {
            const index = parseInt(answer) - 1;
            if (index >= 0 && index < opportunities.length) {
                resolve(opportunities[index]);
            } else {
                console.log('Choix invalide. Sélection de la première opportunité.');
                resolve(opportunities[0]);
            }
        });
    });
}

// Fonction pour demander le montant en SOL
function askForAmount(): Promise<number> {
    return new Promise((resolve) => {
        rl.question('\nMontant en SOL à utiliser: ', (answer) => {
            const amount = parseFloat(answer);
            if (isNaN(amount) || amount <= 0) {
                console.log('Montant invalide. Utilisation de 0.1 SOL par défaut.');
                resolve(0.1);
            } else {
                resolve(amount);
            }
        });
    });
}

async function main() {
    // Configuration
    const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
    console.log(`\nConnexion au RPC: ${RPC_ENDPOINT}`);
    
    const connection = new Connection(RPC_ENDPOINT, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000,
        wsEndpoint: RPC_ENDPOINT.replace('https://', 'wss://')
    });
    
    // Charger le wallet depuis la clé privée
    if (!process.env.WALLET_PRIVATE_KEY) {
        throw new Error("WALLET_PRIVATE_KEY non définie dans .env");
    }

    // Décoder la clé privée depuis le format base58
    const privateKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
    const signer = Keypair.fromSecretKey(privateKey);

    console.log("\n=== Test d'arbitrage en conditions réelles ===");
    console.log(`Wallet: ${signer.publicKey.toString()}`);
    
    try {
        // Vérifier la connexion au RPC
        try {
            const version = await connection.getVersion();
            console.log(`Version Solana: ${version["solana-core"]}`);
            const balance = await connection.getBalance(signer.publicKey);
            console.log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL\n`);
        } catch (error: any) {
            throw new Error(`Erreur de connexion au RPC: ${error.message}`);
        }

        // Trouver les opportunités
        console.log("\nRecherche d'opportunités d'arbitrage...");
        const { opportunities, meteoraPools, raydiumPools } = await findArbitrage();
        
        if (opportunities.length === 0) {
            console.log("Aucune opportunité trouvée");
            rl.close();
            return;
        }

        // Afficher le TOP 10
        console.log('\n' + '🏆 TOP 10 DES MEILLEURES OPPORTUNITÉS D\'ARBITRAGE 🏆');
        console.log('='.repeat(100));
        console.log('│ Rang │ Paire                      │ Profit % │ Direction           │');
        console.log('├──────┼───────────────────────────┼──────────┼────────────────────┤');

        const top10 = opportunities.slice(0, 10);
        top10.forEach((opp, index) => {
            const direction = opp.buyOnMeteora ? 'Buy M → Sell R' : 'Buy R → Sell M';
            console.log(
                `│ ${(index + 1).toString().padStart(4)} │ ` +
                `${opp.pairName.padEnd(23)} │ ` +
                `${opp.expectedProfit.toFixed(2).padStart(8)} │ ` +
                `${direction.padEnd(18)} │`
            );
        });
        console.log('='.repeat(100));

        // Sauvegarder le cache avec les pools déjà chargés
        saveTop10Cache(top10, raydiumPools, meteoraPools);

        // Demander à l'utilisateur de choisir
        const selectedOpp = await askForOpportunity(opportunities);
        const amount = await askForAmount();

        // Préparer l'exécution
        const execution: ArbitrageExecution = {
            ...selectedOpp,
            amountIn: amount
        };

        // Confirmation finale
        console.log(`\nConfirmation de l'exécution :`);
        console.log(`Paire: ${execution.pairName}`);
        console.log(`Direction: ${execution.buyOnMeteora ? 'Buy Meteora -> Sell Raydium' : 'Buy Raydium -> Sell Meteora'}`);
        console.log(`Montant: ${execution.amountIn} SOL`);
        console.log(`Profit attendu: ${execution.expectedProfit.toFixed(2)}%`);

        rl.question('\nConfirmer l\'exécution ? (y/n): ', async (answer) => {
            if (answer.toLowerCase() === 'y') {
                console.log("\nExécution de l'arbitrage...");
                const result = await executeArbitrage(execution, signer, connection);
                console.log("\nRésultat:", result);
            } else {
                console.log("\nExécution annulée.");
            }
            rl.close();
        });

    } catch (error) {
        console.error("Erreur:", error);
        rl.close();
    }
}

main();