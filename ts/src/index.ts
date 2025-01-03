import { connection, WSOL_MINT } from "./config.js";
import { getRaydiumSolPools } from "./pools/raydium.js";
import { getMeteoraSolPools } from "./pools/meteora.js";
import * as readline from 'readline';

// Interface simplifiée pour les pools
interface Pool {
    id: string;
    name: string;
    tokenA: string;
    tokenB: string;
    price: number;
    liquidity: number;
    isSolBase: boolean;
}

interface ArbitrageOpportunity {
    pairName: string;
    priceDiff: number;
    raydiumLiquidity: number;
    meteoraLiquidity: number;
    strategy: string;
    shortRaydiumId: string;
    shortMeteoraId: string;
    raydiumPool: Pool;
    meteoraPool: Pool;
    fullTokenKey?: string;
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

// Fonction pour obtenir l'autre token que SOL dans une paire
function getNonSolToken(pool: Pool): string {
    return pool.tokenA === WSOL_MINT ? pool.tokenB : pool.tokenA;
}

async function findArbitrage() {
    const meteoraPools = await getMeteoraSolPools(connection);
    const raydiumPools = await getRaydiumSolPools(connection);
    const opportunities: ArbitrageOpportunity[] = [];

    console.log("\nDébut du processus de matching...");

    // Create maps for quick lookup using non-SOL token address as key
    const meteoraPoolMap = new Map<string, Pool>();
    let meteoraTokenCount = 0;
    meteoraPools.forEach(pool => {
        const tokenKey = getNonSolToken(pool);
        meteoraPoolMap.set(tokenKey, pool);
        meteoraTokenCount++;
    });
    console.log(`Tokens uniques dans Meteora: ${meteoraTokenCount}`);

    let matchCount = 0;
    let priceFilterCount = 0;
    let liquidityFilterCount = 0;

    // Only iterate through Raydium pools that have matching Meteora pools
    raydiumPools.forEach(raydiumPool => {
        const tokenKey = getNonSolToken(raydiumPool);
        const meteoraPool = meteoraPoolMap.get(tokenKey);

        if (meteoraPool) {
            matchCount++;
            
            if (raydiumPool.price && meteoraPool.price && raydiumPool.price > 0 && meteoraPool.price > 0) {
                // Les prix sont déjà normalisés (1 SOL = X tokens)
                const priceDiff = ((raydiumPool.price - meteoraPool.price) / Math.min(raydiumPool.price, meteoraPool.price)) * 100;

                console.log(`\nAnalyse de la paire: ${raydiumPool.name}`);
                console.log(`Prix Raydium (1 SOL = X tokens): ${raydiumPool.price}`);
                console.log(`Prix Meteora (1 SOL = X tokens): ${meteoraPool.price}`);
                console.log(`Différence: ${priceDiff.toFixed(2)}%`);
                console.log(`Liquidité Raydium: $${raydiumPool.liquidity}`);
                console.log(`Liquidité Meteora: $${meteoraPool.liquidity}`);
                
                // Vérifier les seuils minimums avec des filtres plus réalistes
                if (Math.abs(priceDiff) > 0.5 && Math.abs(priceDiff) < 10.0) {
                    priceFilterCount++;
                    console.log('✅ Passe le filtre de prix');
                    
                    const minLiquidity = 1000;
                    if (raydiumPool.liquidity >= minLiquidity && meteoraPool.liquidity >= minLiquidity) {
                        liquidityFilterCount++;
                        console.log('✅ Passe le filtre de liquidité');
                        
                        // Simplifier la stratégie
                        const strategy = raydiumPool.price > meteoraPool.price
                            ? 'Buy M → Sell R'
                            : 'Buy R → Sell M';

                        // Tronquer les IDs pour l'affichage
                        const shortTokenKey = tokenKey.slice(0, 8) + '...';
                        const shortRaydiumId = raydiumPool.id.slice(0, 8) + '...';
                        const shortMeteoraId = meteoraPool.id.slice(0, 8) + '...';
                        
                        opportunities.push({
                            pairName: `${raydiumPool.name} (${shortTokenKey})`,
                            priceDiff: Math.abs(priceDiff),
                            raydiumLiquidity: raydiumPool.liquidity,
                            meteoraLiquidity: meteoraPool.liquidity,
                            strategy,
                            shortRaydiumId,
                            shortMeteoraId,
                            raydiumPool,
                            meteoraPool,
                            fullTokenKey: tokenKey
                        });
                    } else {
                        console.log('❌ Liquidité insuffisante');
                    }
                } else {
                    console.log('❌ Différence de prix hors limites');
                }
            } else {
                console.log(`\nPrix invalides pour ${raydiumPool.name}`);
                console.log(`Prix Raydium: ${raydiumPool.price}`);
                console.log(`Prix Meteora: ${meteoraPool.price}`);
            }
        }
    });

    console.log("\nStatistiques de matching:");
    console.log(`Total des pools Raydium: ${raydiumPools.length}`);
    console.log(`Total des pools Meteora: ${meteoraPools.length}`);
    console.log(`Nombre de matches trouvés: ${matchCount}`);
    console.log(`Nombre passant le filtre de prix: ${priceFilterCount}`);
    console.log(`Nombre passant le filtre de liquidité: ${liquidityFilterCount}`);
    console.log(`Nombre d'opportunités finales: ${opportunities.length}\n`);

    if (opportunities.length > 0) {
        // Afficher le TOP 10 des opportunités à la fin
        console.log('\n' + '🏆 TOP 10 DES MEILLEURES OPPORTUNITÉS D\'ARBITRAGE 🏆');
        console.log('='.repeat(140));
        console.log('│ Rang │ Paire                      │ Diff %  │ Liq Ray ($)   │ Liq Met ($)   │ Ray Pool ID │ Met Pool ID │ Action  │');
        console.log('├──────┼───────────────────────────┼─────────┼──────────────┼──────────────┼────────────┼────────────┼─────────┤');

        const top10Opportunities = opportunities
            .sort((a, b) => b.priceDiff - a.priceDiff)
            .slice(0, 10);

        top10Opportunities.forEach((opp, index) => {
            console.log(
                `│ ${(index + 1).toString().padStart(4)} │ ` +
                `${opp.pairName.padEnd(23)} │ ` +
                `${opp.priceDiff.toFixed(2).padStart(7)} │ ` +
                `${opp.raydiumLiquidity.toFixed(2).padStart(12)} │ ` +
                `${opp.meteoraLiquidity.toFixed(2).padStart(12)} │ ` +
                `${opp.shortRaydiumId.padEnd(10)} │ ` +
                `${opp.shortMeteoraId.padEnd(10)} │ ` +
                `${opp.strategy.padEnd(7)} │`
            );
        });
        console.log('='.repeat(140));
    } else {
        console.log("\n❌ Aucune opportunité d'arbitrage trouvée");
    }

    // Demander à l'utilisateur s'il veut continuer
    const answer = await askQuestion('\nAppuyez sur Entrée pour rafraîchir ou "q" pour quitter: ');
    return answer.toLowerCase() !== 'q';
}

// Boucle principale
async function main() {
    while (true) {
        const shouldContinue = await findArbitrage();
        if (!shouldContinue) {
            break;
        }
    }
}

main().catch(console.error); 