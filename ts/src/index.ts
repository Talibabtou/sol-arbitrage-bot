import { connection, WSOL_MINT } from "./config.js";
import { getRaydiumSolPools } from "./pools/raydium.js";
import { getMeteoraSolPools } from "./pools/meteora.js";
import * as readline from 'readline';
import { executeArbitrage, ArbitrageExecution } from "./arbitrage/executor.js";
import { Keypair } from "@solana/web3.js";
import bs58 from 'bs58';
import * as dotenv from 'dotenv';

// Charger les variables d'environnement
dotenv.config();

// Define interfaces for our pool types
interface RaydiumPool {
    id: string;
    name: string;
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

interface ArbitrageOpportunity {
    pairName: string;
    priceDiff: number;
    raydiumPrice: number;
    meteoraPrice: number;
    raydiumLiquidity: number;
    meteoraLiquidity: number;
    strategy: string;
    raydiumPool: RaydiumPool;
    meteoraPool: MeteoraPool;
    tokenAddress: string;
    buyOnMeteora: boolean;
}

// Fonction pour lire l'input utilisateur
function askQuestion(query: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

async function findArbitrage() {
    const meteoraPools = await getMeteoraSolPools(connection);
    const raydiumPools = await getRaydiumSolPools(connection);
    const opportunities: ArbitrageOpportunity[] = [];

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
                Math.abs(priceDiff) < 50.0 && // Exclusion des opportunités > 50%
                raydiumPool.liquidity >= 10000 && // Augmentation du seuil de liquidité à 10000$
                meteoraPool.liquidity >= 10000 && // Augmentation du seuil de liquidité à 10000$
                (raydiumSolReserve >= MIN_SOL_RESERVE / 1e9) &&
                meteoraSolReserve >= MIN_SOL_RESERVE) {
                
                const raydiumTokenAddr = raydiumPool.tokenA === WSOL_MINT ? raydiumPool.tokenB : raydiumPool.tokenA;
                const meteoraTokenAddr = meteoraPool.tokenA === WSOL_MINT ? meteoraPool.tokenB : meteoraPool.tokenA;

                const strategy = raydiumTokenAddr !== meteoraTokenAddr 
                    ? '⚠️  Adresses différentes'
                    : priceDiff > 0 
                        ? '➡️  Acheter sur Meteora, Vendre sur Raydium'
                        : '➡️  Acheter sur Raydium, Vendre sur Meteora';

                // Stocker l'opportunité
                opportunities.push({
                    pairName: raydiumPool.name,
                    priceDiff: Math.abs(priceDiff),
                    raydiumPrice: raydiumPool.price,
                    meteoraPrice: meteoraPool.price,
                    raydiumLiquidity: raydiumPool.liquidity,
                    meteoraLiquidity: meteoraPool.liquidity,
                    strategy,
                    raydiumPool: raydiumPool,
                    meteoraPool: meteoraPool,
                    tokenAddress: raydiumTokenAddr,
                    buyOnMeteora: raydiumTokenAddr !== WSOL_MINT
                });

                // Affichage sous forme de tableau
                console.log('\n' + '='.repeat(80));
                console.log(`Paire: ${raydiumPool.name}`);
                console.log('-'.repeat(80));
                
                // Tableau des prix et liquidités
                console.log('│ Exchange │ Prix            │ Liquidité ($)   │ Réserve SOL    │');
                console.log('├──────────┼─────────────────┼────────────────┼────────────────┤');
                console.log(`│ Raydium  │ ${raydiumPool.price.toFixed(8).padEnd(13)} │ ${raydiumPool.liquidity.toFixed(2).padStart(12)} │ ${raydiumSolReserve.toFixed(2).padStart(12)} │`);
                console.log(`│ Meteora  │ ${meteoraPool.price.toFixed(8).padEnd(13)} │ ${meteoraPool.liquidity.toFixed(2).padStart(12)} │ ${(meteoraSolReserve / 1e9).toFixed(2).padStart(12)} │`);
                console.log('-'.repeat(80));

                // Résumé de l'opportunité
                console.log(`Différence de prix: ${priceDiff.toFixed(2)}%`);
                console.log(strategy);
                console.log('='.repeat(80));
            }
        }
    });

    // Afficher le TOP 10 des opportunités à la fin
    console.log('\n\n' + '🏆 TOP 10 DES MEILLEURES OPPORTUNITÉS D\'ARBITRAGE 🏆');
    console.log('='.repeat(100));
    console.log('│ Rang │ Paire            │ Diff %  │ Liquidité Ray ($) │ Liquidité Met ($) │ Stratégie          │');
    console.log('├──────┼──────────────────┼─────────┼──────────────────┼──────────────────┼───────────────────┤');

    const top10Opportunities = opportunities
        .sort((a, b) => b.priceDiff - a.priceDiff)
        .slice(0, 10);

    top10Opportunities.forEach((opp, index) => {
        console.log(
            `│ ${(index + 1).toString().padStart(4)} │ ` +
            `${opp.pairName.padEnd(16)} │ ` +
            `${opp.priceDiff.toFixed(2).padStart(7)} │ ` +
            `${opp.raydiumLiquidity.toFixed(2).padStart(16)} │ ` +
            `${opp.meteoraLiquidity.toFixed(2).padStart(16)} │ ` +
            `${opp.strategy.slice(0, 17).padEnd(17)} │`
        );
    });
    console.log('='.repeat(100));

    // Demander à l'utilisateur s'il veut exécuter un arbitrage
    const answer = await askQuestion('\nEntrez le numéro de l\'opportunité à trader (1-10) ou "q" pour quitter: ');
    
    if (answer.toLowerCase() === 'q') {
        console.log('Au revoir!');
        process.exit(0);
    }

    const opportunityIndex = parseInt(answer) - 1;
    if (opportunityIndex >= 0 && opportunityIndex < top10Opportunities.length) {
        const selectedOpp = top10Opportunities[opportunityIndex];
        
        const amountStr = await askQuestion('Entrez le montant en SOL à trader: ');
        const amount = parseFloat(amountStr);

        if (isNaN(amount) || amount <= 0) {
            console.log('Montant invalide');
            return;
        }

        // Charger la clé privée depuis le fichier .env
        const privateKeyBase58 = process.env.WALLET_PRIVATE_KEY;
        if (!privateKeyBase58) {
            throw new Error("La clé privée n'est pas configurée dans le fichier .env");
        }

        // Convertir la clé privée de base58 en Uint8Array
        const privateKeyBytes = bs58.decode(privateKeyBase58);
        const signer = Keypair.fromSecretKey(privateKeyBytes);

        const execution: ArbitrageExecution = {
            pairName: selectedOpp.pairName,
            raydiumPoolId: selectedOpp.raydiumPool.id,
            meteoraPoolId: selectedOpp.meteoraPool.id,
            expectedProfit: selectedOpp.priceDiff,
            amountIn: amount,
            tokenAddress: selectedOpp.tokenAddress,
            buyOnMeteora: selectedOpp.buyOnMeteora
        };

        console.log(`\nExécution de l'arbitrage sur ${selectedOpp.pairName}...`);
        try {
            const result = await executeArbitrage(execution, signer, connection);
            console.log('Transaction envoyée:', result);
        } catch (error) {
            console.error('Erreur lors de l\'exécution:', error);
        }
    } else {
        console.log('Numéro d\'opportunité invalide');
    }
}

// Boucle principale
async function main() {
    while (true) {
        await findArbitrage();
        const answer = await askQuestion('\nAppuyez sur Entrée pour rafraîchir ou "q" pour quitter: ');
        if (answer.toLowerCase() === 'q') {
            break;
        }
    }
}

main().catch(console.error); 