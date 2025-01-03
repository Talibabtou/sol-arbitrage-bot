import { 
    Connection, 
    PublicKey, 
    Transaction, 
    SystemProgram,
    TransactionInstruction, 
    Keypair, 
    ComputeBudgetProgram, 
    sendAndConfirmTransaction, 
    LAMPORTS_PER_SOL, 
    SYSVAR_RENT_PUBKEY
} from "@solana/web3.js";
import { FAST_API_KEY } from "../config.js";
import { NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import BN from 'bn.js';
import { 
    Liquidity, 
    LiquidityPoolKeys, 
    Token, 
    TxVersion,
    TokenAmount,
    Currency,
    CurrencyAmount,
    TOKEN_PROGRAM_ID,
    MAINNET_PROGRAM_ID,
    Percent
} from "@raydium-io/raydium-sdk";
import path from 'path';
import fs from 'fs';

// Constants pour Fast
const FAST_URL = "https://fast.circular.bot/transactions";
const FAST_TIP = new PublicKey("FAST3dMFZvESiEipBvLSiXq3QCV51o3xuoHScqRU6cB6");
const MIN_TIP_AMOUNT = 1_000_000; // 0.001 SOL

// Constants pour le cache
const TOP10_CACHE_FILE = path.join(process.cwd(), 'cache', 'top10_opportunities.json');

// Constants pour la sécurité
const MIN_PROFIT_BPS = 50; // 0.5% de profit minimum
const MAX_PRICE_IMPACT_BPS = 100; // 1% d'impact prix maximum
const SLIPPAGE_BPS = 100; // 1% de slippage maximum

// Constants pour les frais
const PRIORITY_FEES = 1_000_000; // 0.001 SOL pour les priority fees
const TOTAL_FEES = PRIORITY_FEES + MIN_TIP_AMOUNT; // Priority fees + tip Fast

// Constants pour Raydium
const RAYDIUM_PROGRAM_IDS = {
    4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    5: new PublicKey("5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h")
};

// Constants pour Meteora
const METEORA_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// Cache pour les poolKeys de Raydium
let raydiumPoolKeysCache: LiquidityPoolKeys[] = [];
let lastCacheUpdate = 0;
const CACHE_DURATION = 60 * 1000; // 60 secondes

// Constante pour l'adresse de Fast
const FAST_TIP_ADDRESS = new PublicKey("FASTQyniV3ULxsrhWZyHFZQ6MKyzVPPBiQpqkwAyHGu6");
const TIP_AMOUNT = 0.001; // 0.001 SOL par transaction

// Instruction layout pour Meteora
const SWAP_LAYOUT = {
    SWAP: 1, // Code d'instruction pour swap
    AMOUNT_IN: 8, // Taille en bytes pour le montant
    MIN_AMOUNT_OUT: 8 // Taille en bytes pour le montant minimum
};

// Instruction layout pour Raydium
const RAYDIUM_SWAP_LAYOUT = {
    SWAP: 9, // Code d'instruction pour swap
    AMOUNT_IN: 8, // Taille en bytes pour le montant
    MIN_AMOUNT_OUT: 8 // Taille en bytes pour le montant minimum
};

// Cache pour le top 10
interface CachedOpportunity {
    pairName: string;
    raydiumPoolId: string;
    meteoraPoolId: string;
    tokenAddress: string;
    expectedProfit: number;
    amountIn: number;
    buyOnMeteora: boolean;
    raydiumPoolInfo?: any;
    meteoraPoolInfo?: any;
}

interface Top10Cache {
    timestamp: number;
    opportunities: CachedOpportunity[];
}

let top10Cache: Top10Cache = {
    timestamp: 0,
    opportunities: []
};

// Fonction pour sauvegarder le cache du TOP 10
export function saveTop10Cache(opportunities: ArbitrageExecution[], raydiumPools: any[], meteoraPools: any[]) {
    console.log("\nMise à jour du cache TOP 10...");
    
    // Créer le dossier cache si nécessaire
    const cacheDir = path.dirname(TOP10_CACHE_FILE);
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Préparer les données du cache
    const cacheData: Top10Cache = {
        timestamp: Date.now(),
        opportunities: opportunities.slice(0, 10).map(opp => {
            const raydiumPool = raydiumPools.find(p => p.id === opp.raydiumPoolId);
            const meteoraPool = meteoraPools.find(p => p.id === opp.meteoraPoolId);

            if (!raydiumPool) {
                console.warn(`Pool Raydium non trouvé pour l'opportunité: ${opp.raydiumPoolId}`);
            }
            if (!meteoraPool) {
                console.warn(`Pool Meteora non trouvé pour l'opportunité: ${opp.meteoraPoolId}`);
            }

            return {
                ...opp,
                raydiumPoolInfo: raydiumPool ? {
                    ...raydiumPool,
                    ammId: raydiumPool.id,
                    ammAuthority: raydiumPool.authority || raydiumPool.ammAuthority,
                    ammOpenOrders: raydiumPool.openOrders || raydiumPool.ammOpenOrders,
                    ammTargetOrders: raydiumPool.targetOrders || raydiumPool.ammTargetOrders,
                    poolCoinTokenAccount: raydiumPool.baseVault || raydiumPool.poolCoinTokenAccount,
                    poolPcTokenAccount: raydiumPool.quoteVault || raydiumPool.poolPcTokenAccount
                } : null,
                meteoraPoolInfo: meteoraPool || null
            };
        })
    };

    // Sauvegarder dans le fichier
    fs.writeFileSync(TOP10_CACHE_FILE, JSON.stringify(cacheData, null, 2));
    console.log(`Cache TOP 10 sauvegardé dans ${TOP10_CACHE_FILE}`);
    
    // Mettre à jour le cache en mémoire
    top10Cache = cacheData;
}

// Fonction pour obtenir une opportunité du cache
export function getCachedOpportunity(raydiumPoolId: string, meteoraPoolId: string): CachedOpportunity | null {
    if (Date.now() - top10Cache.timestamp > 5 * 60 * 1000) { // Cache expiré après 5 minutes
        return null;
    }
    
    // On cherche l'opportunité qui correspond exactement aux deux pool IDs
    return top10Cache.opportunities.find(
        opp => opp.raydiumPoolId === raydiumPoolId || opp.meteoraPoolId === meteoraPoolId
    ) || null;
}

// Fonction pour obtenir les poolKeys avec cache
async function getRaydiumPoolKeys(connection: Connection): Promise<LiquidityPoolKeys[]> {
    const now = Date.now();
    
    // Si le cache est valide, on l'utilise
    if (raydiumPoolKeysCache.length > 0 && (now - lastCacheUpdate) < CACHE_DURATION) {
        console.log("Utilisation du cache Raydium");
        return raydiumPoolKeysCache;
    }

    // Sinon, on rafraîchit le cache
    console.log("Rafraîchissement du cache Raydium");
    
    try {
        // Utiliser axios pour gérer automatiquement les gros fichiers
        const axios = require('axios');
        const response = await axios.get('https://api.raydium.io/v2/sdk/liquidity/mainnet.json', {
            responseType: 'json',
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const data = response.data;
        console.log(`Nombre de pools Raydium trouvés: ${data.official.length}`);
        
        // Convertir les données en LiquidityPoolKeys
        raydiumPoolKeysCache = data.official.map((pool: any) => ({
            id: new PublicKey(pool.id),
            baseMint: new PublicKey(pool.baseMint),
            quoteMint: new PublicKey(pool.quoteMint),
            lpMint: new PublicKey(pool.lpMint),
            baseDecimals: pool.baseDecimals,
            quoteDecimals: pool.quoteDecimals,
            lpDecimals: pool.lpDecimals,
            version: pool.version,
            programId: new PublicKey(pool.programId),
            authority: new PublicKey(pool.authority),
            openOrders: new PublicKey(pool.openOrders),
            targetOrders: new PublicKey(pool.targetOrders),
            baseVault: new PublicKey(pool.baseVault),
            quoteVault: new PublicKey(pool.quoteVault),
            withdrawQueue: new PublicKey(pool.withdrawQueue),
            lpVault: new PublicKey(pool.lpVault),
            marketVersion: pool.marketVersion,
            marketProgramId: new PublicKey(pool.marketProgramId),
            marketId: new PublicKey(pool.marketId),
            marketAuthority: new PublicKey(pool.marketAuthority),
            marketBaseVault: new PublicKey(pool.marketBaseVault),
            marketQuoteVault: new PublicKey(pool.marketQuoteVault),
            marketBids: new PublicKey(pool.marketBids),
            marketAsks: new PublicKey(pool.marketAsks),
            marketEventQueue: new PublicKey(pool.marketEventQueue)
        }));

        lastCacheUpdate = now;
        return raydiumPoolKeysCache;
    } catch (error) {
        console.error("Erreur lors de la récupération des pools Raydium:", error);
        throw error;
    }
}

async function createMeteoraSwapInstructions(
    poolId: string,
    amountIn: number,
    isWsolToToken: boolean,
    signer: Keypair,
    connection: Connection,
    tokenAddress: string
): Promise<TransactionInstruction[]> {
    try {
        console.log(`\n=== Création du swap Meteora ===`);
        console.log(`Pool ID: ${poolId}`);
        console.log(`Amount In: ${amountIn} SOL`);
        console.log(`Direction: ${isWsolToToken ? 'SOL -> Token' : 'Token -> SOL'}`);
        console.log(`Token Address: ${tokenAddress}`);

        // 1. Obtenir les ATAs
        const tokenAta = await getAssociatedTokenAddress(
            new PublicKey(tokenAddress),
            signer.publicKey
        );
        console.log("Token ATA:", tokenAta.toString());

        // 2. Créer le buffer de données pour l'instruction
        const data = Buffer.alloc(1 + 8 + 8);
        data.writeUInt8(SWAP_LAYOUT.SWAP, 0);
        data.writeBigUInt64LE(BigInt(amountIn * LAMPORTS_PER_SOL), 1);
        data.writeBigUInt64LE(BigInt(0), 9);

        // 3. Créer l'instruction de swap
        const swapIx = new TransactionInstruction({
            programId: METEORA_PROGRAM_ID,
            keys: [
                { pubkey: signer.publicKey, isSigner: true, isWritable: true },
                { pubkey: new PublicKey(poolId), isSigner: false, isWritable: true },
                { pubkey: tokenAta, isSigner: false, isWritable: true },
                { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
            ],
            data: data
        });

        const instructions: TransactionInstruction[] = [];
        if (isWsolToToken) {
            const wrapSolIx = SystemProgram.transfer({
                fromPubkey: signer.publicKey,
                toPubkey: tokenAta,
                lamports: amountIn * LAMPORTS_PER_SOL
            });
            instructions.push(wrapSolIx);
        }

        instructions.push(swapIx);
        return instructions;

    } catch (error) {
        console.error("Erreur détaillée lors de la création des instructions Meteora:", error);
        throw error;
    }
}

async function createRaydiumSwapInstructions(
    poolId: string,
    amountIn: number,
    isWsolToToken: boolean,
    signer: Keypair,
    tokenAddress: string,
    connection: Connection
): Promise<TransactionInstruction[]> {
    try {
        console.log(`\n=== Création du swap Raydium ===`);
        console.log(`Pool ID: ${poolId}`);
        console.log(`Amount In: ${amountIn} SOL`);
        console.log(`Direction: ${isWsolToToken ? 'SOL -> Token' : 'Token -> SOL'}`);
        console.log(`Token Address: ${tokenAddress}`);

        // 1. Obtenir les ATAs
        const tokenAta = await getAssociatedTokenAddress(
            new PublicKey(tokenAddress),
            signer.publicKey
        );
        console.log("Token ATA:", tokenAta.toString());

        // 2. Obtenir les informations de la pool
        const poolInfo = await connection.getAccountInfo(new PublicKey(poolId));
        if (!poolInfo) {
            throw new Error("Pool non trouvée");
        }

        // 3. Créer le buffer de données pour l'instruction
        const data = Buffer.alloc(1 + 8 + 8);
        data.writeUInt8(RAYDIUM_SWAP_LAYOUT.SWAP, 0);
        data.writeBigUInt64LE(BigInt(amountIn * LAMPORTS_PER_SOL), 1);
        data.writeBigUInt64LE(BigInt(0), 9);

        // 4. Créer l'instruction de swap
        const swapIx = new TransactionInstruction({
            programId: RAYDIUM_PROGRAM_IDS[5],
            keys: [
                { pubkey: signer.publicKey, isSigner: true, isWritable: true },
                { pubkey: new PublicKey(poolId), isSigner: false, isWritable: true },
                { pubkey: new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), isSigner: false, isWritable: false }, // Authority
                { pubkey: tokenAta, isSigner: false, isWritable: true },
                { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
            ],
            data: data
        });

        const instructions: TransactionInstruction[] = [];
        if (isWsolToToken) {
            const wrapSolIx = SystemProgram.transfer({
                fromPubkey: signer.publicKey,
                toPubkey: tokenAta,
                lamports: amountIn * LAMPORTS_PER_SOL
            });
            instructions.push(wrapSolIx);
        }

        instructions.push(swapIx);
        return instructions;

    } catch (error) {
        console.error("Erreur détaillée lors de la création des instructions Raydium:", error);
        throw error;
    }
}

export interface ArbitrageExecution {
    pairName: string;
    raydiumPoolId: string;
    meteoraPoolId: string;
    expectedProfit: number;
    amountIn: number;
    tokenAddress: string;
    buyOnMeteora: boolean;
}

// Fonction pour vérifier la profitabilité des quotes
async function verifyQuotes(
    meteoraQuote: any,
    raydiumQuote: any,
    amountIn: number,
    expectedProfit: number
): Promise<boolean> {
    // Convertir les montants en SOL pour la comparaison
    const amountInSol = amountIn * 1e9;
    const meteoraOutAmount = Number(meteoraQuote.minOutAmount) / 1e9;
    const raydiumOutAmount = Number(raydiumQuote.minAmountOut) / 1e9;
    
    // Calculer le profit attendu
    const profitAmount = Math.abs(meteoraOutAmount - raydiumOutAmount);
    const totalFeesSol = TOTAL_FEES / LAMPORTS_PER_SOL;
    const netProfit = profitAmount - totalFeesSol;
    const profitPercentage = (netProfit / amountIn) * 100;
    
    console.log(`\nVérification de la profitabilité:`);
    console.log(`Montant d'entrée: ${amountIn} SOL`);
    console.log(`Montant de sortie Meteora: ${meteoraOutAmount} SOL`);
    console.log(`Montant de sortie Raydium: ${raydiumOutAmount} SOL`);
    console.log(`Profit brut: ${profitAmount.toFixed(4)} SOL`);
    console.log(`Frais totaux: ${totalFeesSol.toFixed(4)} SOL (${(PRIORITY_FEES/LAMPORTS_PER_SOL).toFixed(4)} priority + ${(MIN_TIP_AMOUNT/LAMPORTS_PER_SOL).toFixed(4)} tip)`);
    console.log(`Profit net: ${netProfit.toFixed(4)} SOL (${profitPercentage.toFixed(2)}%)`);
    
    // Vérifier que le profit net est suffisant
    const isProfit = profitPercentage >= MIN_PROFIT_BPS / 100;
    console.log(isProfit ? '✅ Profit suffisant' : '❌ Profit insuffisant');
    
    return isProfit;
}

// Instruction pour vérifier le solde final
function createProfitCheckInstruction(
    signer: PublicKey,
    minBalance: number // en lamports
): TransactionInstruction {
    // Créer une instruction qui vérifie le solde
    const data = Buffer.alloc(9);
    data.writeUInt8(0, 0); // Instruction index pour vérifier le solde
    data.writeBigUInt64LE(BigInt(minBalance), 1); // Solde minimum requis

    return new TransactionInstruction({
        keys: [
            { pubkey: signer, isSigner: true, isWritable: false },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
        ],
        programId: SystemProgram.programId,
        data
    });
}

// Fonction pour créer l'instruction de tip
function createFastTipInstruction(
    signer: PublicKey,
    tipAmount: number = TIP_AMOUNT
): TransactionInstruction {
    return SystemProgram.transfer({
        fromPubkey: signer,
        toPubkey: FAST_TIP_ADDRESS,
        lamports: tipAmount * LAMPORTS_PER_SOL
    });
}

// Scénario 1: Buy on Meteora -> Sell on Raydium
async function executeBuyMeteoraToSellRaydium(
    execution: ArbitrageExecution,
    signer: Keypair,
    connection: Connection
): Promise<Transaction> {
    console.log("\n=== Exécution Buy Meteora -> Sell Raydium ===");
    console.log(`Montant d'entrée: ${execution.amountIn} SOL`);
    
    const transaction = new Transaction();
    
    // Augmenter le budget de calcul et ajouter les priority fees
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000
    });
    const priorityFeesIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.floor((PRIORITY_FEES * 1_000_000) / 1_400_000)
    });
    transaction.add(computeBudgetIx, priorityFeesIx);

    // 1. Swap SOL -> Token sur Meteora
    console.log("1. Préparation du swap Meteora (SOL -> Token)...");
    const meteoraInstructions = await createMeteoraSwapInstructions(
        execution.meteoraPoolId,
        execution.amountIn,
        true, // SOL -> Token
        signer,
        connection,
        execution.tokenAddress
    );

    // 2. Swap Token -> SOL sur Raydium
    console.log("2. Préparation du swap Raydium (Token -> SOL)...");
    const raydiumInstructions = await createRaydiumSwapInstructions(
        execution.raydiumPoolId,
        execution.amountIn,
        false, // Token -> SOL
        signer,
        execution.tokenAddress,
        connection
    );

    // Ajouter les instructions dans l'ordre
    transaction.add(
        ...meteoraInstructions,
        ...raydiumInstructions
    );

    // Ajouter le tip à Fast
    const tipIx = createFastTipInstruction(signer.publicKey);
    transaction.add(tipIx);

    return transaction;
}

// Scénario 2: Buy on Raydium -> Sell on Meteora
async function executeBuyRaydiumToSellMeteora(
    execution: ArbitrageExecution,
    signer: Keypair,
    connection: Connection
): Promise<Transaction> {
    console.log("\n=== Exécution Buy Raydium -> Sell Meteora ===");
    console.log(`Montant d'entrée: ${execution.amountIn} SOL`);
    
    const transaction = new Transaction();
    
    // Augmenter le budget de calcul et ajouter les priority fees
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000
    });
    const priorityFeesIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.floor((PRIORITY_FEES * 1_000_000) / 1_400_000)
    });
    transaction.add(computeBudgetIx, priorityFeesIx);

    // 1. Swap SOL -> Token sur Raydium
    console.log("1. Préparation du swap Raydium (SOL -> Token)...");
    const raydiumInstructions = await createRaydiumSwapInstructions(
        execution.raydiumPoolId,
        execution.amountIn,
        true, // SOL -> Token
        signer,
        execution.tokenAddress,
        connection
    );
    
    // 2. Swap Token -> SOL sur Meteora
    console.log("2. Préparation du swap Meteora (Token -> SOL)...");
    const meteoraInstructions = await createMeteoraSwapInstructions(
        execution.meteoraPoolId,
        execution.amountIn,
        false, // Token -> SOL
        signer,
        connection,
        execution.tokenAddress
    );

    // Ajouter les instructions dans l'ordre
    transaction.add(
        ...raydiumInstructions,
        ...meteoraInstructions
    );

    // Ajouter le tip à Fast
    const tipIx = createFastTipInstruction(signer.publicKey);
    transaction.add(tipIx);

    return transaction;
}

export async function executeArbitrage(
    execution: ArbitrageExecution,
    signer: Keypair,
    connection: Connection
) {
    try {
        // Sélectionner la stratégie appropriée
        const transaction = execution.buyOnMeteora 
            ? await executeBuyMeteoraToSellRaydium(execution, signer, connection)
            : await executeBuyRaydiumToSellMeteora(execution, signer, connection);
        
        // Ajout du tip pour Fast en dernière instruction
        console.log("3. Ajout du tip Fast...");
        const tipIx = SystemProgram.transfer({
            fromPubkey: signer.publicKey,
            toPubkey: FAST_TIP,
            lamports: MIN_TIP_AMOUNT,
        });
        transaction.add(tipIx);

        // Finalisation de la transaction
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = signer.publicKey;
        transaction.sign(signer);

        // Sérialisation et envoi via Fast
        console.log("4. Envoi de la transaction via Fast...");
        const serializedTx = transaction.serialize().toString("base64");
        
        if (!FAST_API_KEY) {
            throw new Error("FAST_API_KEY is not defined");
        }

        const headers: HeadersInit = {
            "Content-Type": "application/json",
            "x-api-key": FAST_API_KEY
        };

        const response = await fetch(FAST_URL, {
            method: "POST",
            headers,
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sendTransaction",
                params: [
                    serializedTx,
                    {
                        frontRunningProtection: false
                    }
                ]
            })
        });

        const result = await response.json();
        
        if (result.result && result.result.signature) {
            const txHash = result.result.signature;
            console.log('\n=== Transaction envoyée avec succès ===');
            console.log(`Hash: ${txHash}`);
            console.log(`Explorer: https://solscan.io/tx/${txHash}`);
            console.log('=====================================\n');
        }

        return result;
    } catch (error) {
        console.error("Erreur lors de l'exécution de l'arbitrage:", error);
        throw error;
    }
} 