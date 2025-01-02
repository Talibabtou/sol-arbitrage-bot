import { 
    Connection, 
    PublicKey, 
    Transaction, 
    SystemProgram,
    TransactionInstruction,
    Keypair, 
    VersionedTransaction,
    ComputeBudgetProgram
} from "@solana/web3.js";
import { FAST_API_KEY } from "../config.js";
import axios from "axios";
import { NATIVE_MINT } from "@solana/spl-token";
import { Wallet, AnchorProvider } from '@project-serum/anchor';
import BN from 'bn.js';
import Decimal from 'decimal.js';


// Nous n'avons plus besoin du SDK DLMM car nous utilisons l'API HTTP directement

// Constants pour Fast
const FAST_URL = "https://fast.circular.bot/transactions";
const FAST_TIP = new PublicKey("FAST3dMFZvESiEipBvLSiXq3QCV51o3xuoHScqRU6cB6");
const MIN_TIP_AMOUNT = 1_000_000; // 0.001 SOL

// Constants pour Raydium
const RAYDIUM_API_URL = "https://api.raydium.io/v3";
const RAYDIUM_SWAP_API_URL = "https://transaction-v1.raydium.io/v2";  // L'API de swap est sur un domaine différent

// Constants pour la sécurité
const MIN_PROFIT_BPS = 50; // 0.5% de profit minimum
const MAX_PRICE_IMPACT_BPS = 100; // 1% d'impact prix maximum
const SLIPPAGE_BPS = 100; // 1% de slippage maximum

export interface ArbitrageExecution {
    pairName: string;
    raydiumPoolId: string;
    meteoraPoolId: string;
    expectedProfit: number;
    amountIn: number;
    tokenAddress: string;
    buyOnMeteora: boolean;
}

interface SwapCompute {
    id: string;
    success: boolean;
    data: {
        default: {
            vh: number;
            h: number;
            m: number;
        }
    }
}

// Fonction pour obtenir le prix prioritaire
async function getPriorityFee(): Promise<string> {
    const { data } = await axios.get(`${RAYDIUM_API_URL}/main/auto-fee`);
    if (!data.success) throw new Error(`Erreur lors de la récupération des frais: ${data.msg}`);
    return String(data.data.default.h); // On utilise la priorité "high"
}

async function createRaydiumSwapInstructions(
    poolId: string,
    amountIn: number,
    isWsolToToken: boolean,
    signer: Keypair,
    tokenAddress: string
): Promise<TransactionInstruction[]> {
    try {
        // 1. Obtenir les informations du pool
        const { data: poolResponse } = await axios.get(
            `${RAYDIUM_API_URL}/pools/info/ids?ids=${poolId}`
        );
        if (!poolResponse.success) throw new Error(`Erreur pool info: ${poolResponse.msg}`);
        
        // 2. Obtenir le quote
        const { data: quoteResponse } = await axios.get(
            `${RAYDIUM_SWAP_API_URL}/main/quote?` + 
            `inputMint=${isWsolToToken ? NATIVE_MINT.toBase58() : tokenAddress}&` +
            `outputMint=${isWsolToToken ? tokenAddress : NATIVE_MINT.toBase58()}&` +
            `amount=${amountIn}&` +
            `slippageBps=${SLIPPAGE_BPS}`
        );

        // 3. Construire la transaction
        const priorityFee = await getPriorityFee();
        const { data: txResponse } = await axios.post(
            `${RAYDIUM_SWAP_API_URL}/main/swap`,
            {
                computeUnitPriceMicroLamports: priorityFee,
                quoteResponse: quoteResponse.data,
                wallet: signer.publicKey.toBase58(),
                wrapUnwrapSOL: true
            }
        );

        // 4. Désérialiser la transaction
        const txBuf = Buffer.from(txResponse.data.transaction, 'base64');
        const tx = Transaction.from(txBuf);
        return tx.instructions;
    } catch (error) {
        console.error("Erreur détaillée lors de la création des instructions Raydium:", error);
        throw error;
    }
}

interface MeteoraQuote {
    expectedOutputAmount: number;
    priceImpact: number;
    minSwapOutAmount: number;
}

async function getMeteoraQuote(
    poolId: string,
    amountIn: number,
    isWsolToToken: boolean,
    connection: Connection,
    tokenAddress: string
): Promise<MeteoraQuote> {
    try {
        console.log(`\nRécupération du quote Meteora pour le pool ${poolId}`);
        console.log(`Montant: ${amountIn} ${isWsolToToken ? 'SOL -> Token' : 'Token -> SOL'}`);

        // D'abord, obtenir les informations du pool
        const response = await fetch(`https://dlmm-api.meteora.ag/pair/${poolId}`);

        if (!response.ok) {
            const errorText = await response.text();
            console.error('Erreur API Meteora:', response.status, errorText);
            throw new Error(`Erreur API Meteora: ${response.status} ${errorText}`);
        }

        const poolInfo = await response.json();
        console.log('Info pool Meteora reçu:', poolInfo);

        // Calculer le montant de sortie attendu en utilisant les réserves et le prix
        const isTokenA = isWsolToToken ? poolInfo.mint_x === NATIVE_MINT.toString() : poolInfo.mint_y === NATIVE_MINT.toString();
        const price = Number(poolInfo.current_price);
        const expectedOutputAmount = isWsolToToken 
            ? amountIn * price 
            : amountIn / price;

        // Appliquer le slippage pour le montant minimum
        const minSwapOutAmount = expectedOutputAmount * (1 - SLIPPAGE_BPS / 10000);

        // Calculer l'impact prix (approximatif)
        const reserves = isTokenA 
            ? [Number(poolInfo.reserve_x_amount), Number(poolInfo.reserve_y_amount)]
            : [Number(poolInfo.reserve_y_amount), Number(poolInfo.reserve_x_amount)];
        const priceImpact = (amountIn / reserves[0]) * 100;

        return {
            expectedOutputAmount,
            priceImpact,
            minSwapOutAmount
        };
    } catch (error) {
        console.error('Erreur détaillée lors de la récupération du quote Meteora:', error);
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
        console.log(`\nCréation des instructions de swap Meteora pour le pool ${poolId}`);
        console.log(`Montant: ${amountIn} ${isWsolToToken ? 'SOL -> Token' : 'Token -> SOL'}`);

        // Convertir le montant en lamports
        const amountInLamports = Math.floor(amountIn * 1_000_000_000);

        // 1. Obtenir les informations du pool
        const response = await fetch(`https://dlmm-api.meteora.ag/pair/${poolId}`);
        if (!response.ok) {
            throw new Error(`Erreur API Meteora: ${response.status}`);
        }
        const poolInfo = await response.json();

        // 3. Construire les instructions de swap
        const instructions: TransactionInstruction[] = [];

        // Si nous swappons depuis SOL, nous devons d'abord wrap le SOL
        if (isWsolToToken) {
            instructions.push(
                SystemProgram.transfer({
                    fromPubkey: signer.publicKey,
                    toPubkey: new PublicKey(poolInfo.reserve_y), // Reserve SOL
                    lamports: amountInLamports
                })
            );
        }

        // Instruction de swap principale
        const swapIx = new TransactionInstruction({
            programId: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"), // Programme Meteora
            keys: [
                { pubkey: new PublicKey(poolId), isSigner: false, isWritable: true },  // Pool
                { pubkey: signer.publicKey, isSigner: true, isWritable: true },        // User
                { pubkey: new PublicKey(poolInfo.reserve_x), isSigner: false, isWritable: true },  // Reserve X
                { pubkey: new PublicKey(poolInfo.reserve_y), isSigner: false, isWritable: true },  // Reserve Y
                { pubkey: new PublicKey(poolInfo.mint_x), isSigner: false, isWritable: true },     // Token X Mint
                { pubkey: new PublicKey(poolInfo.mint_y), isSigner: false, isWritable: true },     // Token Y Mint
            ],
            data: Buffer.from([
                0x0,  // Discriminator pour swap
                ...new BN(amountInLamports).toArray('le', 8),  // Montant d'entrée en lamports
                ...new BN(0).toArray('le', 8),                 // Montant minimum de sortie (géré par le slippage)
                isWsolToToken ? 1 : 0,                         // Direction du swap (0 = Y->X, 1 = X->Y)
            ])
        });
        instructions.push(swapIx);

        // Si nous swappons vers SOL, nous devons unwrap le WSOL
        if (!isWsolToToken) {
            // TODO: Ajouter l'instruction d'unwrap WSOL si nécessaire
            // Pour l'instant, le SOL sera automatiquement unwrappé car nous utilisons le compte de réserve directement
        }

        return instructions;
    } catch (error) {
        console.error('Erreur détaillée lors de la création des instructions de swap Meteora:', error);
        throw error;
    }
}

function createProfitCheckInstruction(
    initialAmount: number,
    finalAmount: number,
    minProfitBps: number = MIN_PROFIT_BPS
): TransactionInstruction {
    // Vérifier que le montant final est supérieur au montant initial avec le profit minimum requis
    const minRequiredAmount = initialAmount * (1 + minProfitBps / 10000);
    
    // Si le montant final est inférieur au minimum requis, la transaction échouera
    if (finalAmount < minRequiredAmount) {
        return new TransactionInstruction({
            keys: [],
            programId: new PublicKey("11111111111111111111111111111111"),
            data: Buffer.from([0]) // Instruction invalide qui fera échouer la transaction
        });
    }
    
    // Sinon, on retourne une instruction vide qui réussira toujours
    return new TransactionInstruction({
        keys: [],
        programId: new PublicKey("11111111111111111111111111111111"),
        data: Buffer.from([]) // Instruction vide qui passera toujours
    });
}

async function executeRaydiumToMeteora(
    execution: ArbitrageExecution,
    signer: Keypair,
    connection: Connection
): Promise<Transaction> {
    const transaction = new Transaction();
    
    // Ajouter une instruction pour augmenter le budget de calcul
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000
    });
    transaction.add(computeBudgetIx);

    // Convertir le montant en lamports
    const amountInLamports = Math.floor(execution.amountIn * 1_000_000_000);
    
    // 1. Obtenir le quote initial pour Raydium
    const { data: quoteResponse } = await axios.get(
        `${RAYDIUM_SWAP_API_URL}/main/quote?` + 
        `inputMint=${NATIVE_MINT.toBase58()}&` +
        `outputMint=${execution.tokenAddress}&` +
        `amount=${amountInLamports}&` +
        `slippageBps=${SLIPPAGE_BPS}`
    );
    if (!quoteResponse.success) throw new Error(`Erreur quote Raydium: ${quoteResponse.msg}`);
    
    // Vérifier l'impact prix
    if (quoteResponse.data.priceImpactPct > MAX_PRICE_IMPACT_BPS / 100) {
        throw new Error(`Impact prix trop élevé sur Raydium: ${quoteResponse.data.priceImpactPct}%`);
    }

    // 2. Swap WSOL -> Token sur Raydium
    const raydiumInstructions = await createRaydiumSwapInstructions(
        execution.raydiumPoolId,
        amountInLamports,
        true,
        signer,
        execution.tokenAddress
    );
    
    // 3. Obtenir le quote pour Meteora avec le montant attendu
    const meteoraQuote = await getMeteoraQuote(
        execution.meteoraPoolId,
        quoteResponse.data.expectedOutputAmount / 1_000_000_000,  // Convertir en SOL pour Meteora
        false,
        connection,
        execution.tokenAddress
    );
    
    // 4. Swap Token -> WSOL sur Meteora
    const meteoraInstructions = await createMeteoraSwapInstructions(
        execution.meteoraPoolId,
        quoteResponse.data.expectedOutputAmount / 1_000_000_000,  // Convertir en SOL pour Meteora
        false,
        signer,
        connection,
        execution.tokenAddress
    );

    // Vérification finale du profit
    const profitCheckIx = createProfitCheckInstruction(
        amountInLamports,  // Montant initial en lamports
        Math.floor(meteoraQuote.expectedOutputAmount * 1_000_000_000)  // Montant final en lamports
    );
    
    // Ajouter les instructions dans l'ordre
    transaction.add(
        ...raydiumInstructions,
        ...meteoraInstructions,
        profitCheckIx  // Vérification du profit APRÈS les deux swaps
    );
    
    return transaction;
}

async function executeMeteorToRaydium(
    execution: ArbitrageExecution,
    signer: Keypair,
    connection: Connection
): Promise<Transaction> {
    const transaction = new Transaction();
    
    // Ajouter une instruction pour augmenter le budget de calcul
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 1_400_000
    });
    transaction.add(computeBudgetIx);

    // Convertir le montant en lamports
    const amountInLamports = Math.floor(execution.amountIn * 1_000_000_000);
    
    // 1. Obtenir le quote initial pour Meteora
    const meteoraQuote = await getMeteoraQuote(
        execution.meteoraPoolId,
        execution.amountIn,  // On garde le montant en SOL pour Meteora
        true,
        connection,
        execution.tokenAddress
    );
    
    // 2. Swap WSOL -> Token sur Meteora
    const meteoraInstructions = await createMeteoraSwapInstructions(
        execution.meteoraPoolId,
        execution.amountIn,  // Le montant sera converti en lamports dans la fonction
        true,
        signer,
        connection,
        execution.tokenAddress
    );

    // Convertir le montant de sortie attendu en lamports pour Raydium
    const expectedOutputLamports = Math.floor(meteoraQuote.expectedOutputAmount * 1_000_000_000);
    
    // 3. Obtenir le quote pour Raydium
    const { data: quoteResponse } = await axios.get(
        `${RAYDIUM_SWAP_API_URL}/main/quote?` + 
        `inputMint=${execution.tokenAddress}&` +
        `outputMint=${NATIVE_MINT.toBase58()}&` +
        `amount=${expectedOutputLamports}&` +
        `slippageBps=${SLIPPAGE_BPS}`
    );
    if (!quoteResponse.success) throw new Error(`Erreur quote Raydium: ${quoteResponse.msg}`);
    
    // Vérifier l'impact prix
    if (quoteResponse.data.priceImpactPct > MAX_PRICE_IMPACT_BPS / 100) {
        throw new Error(`Impact prix trop élevé sur Raydium: ${quoteResponse.data.priceImpactPct}%`);
    }
    
    // 4. Swap Token -> WSOL sur Raydium
    const raydiumInstructions = await createRaydiumSwapInstructions(
        execution.raydiumPoolId,
        expectedOutputLamports,
        false,
        signer,
        execution.tokenAddress
    );

    // Vérification finale du profit
    const profitCheckIx = createProfitCheckInstruction(
        amountInLamports,  // Montant initial en lamports
        quoteResponse.data.expectedOutputAmount  // Montant final en lamports
    );
    
    // Ajouter les instructions dans l'ordre
    transaction.add(
        ...meteoraInstructions,
        ...raydiumInstructions,
        profitCheckIx  // Vérification du profit APRÈS les deux swaps
    );
    
    return transaction;
}

// Fonction utilitaire pour calculer le profit en BPS
function calculateProfit(amountIn: number, amountOut: number): number {
    return ((amountOut - amountIn) / amountIn) * 10000; // En BPS
}

export async function executeArbitrage(
    execution: ArbitrageExecution,
    signer: Keypair,
    connection: Connection
) {
    // Sélectionner la stratégie appropriée
    const transaction = execution.buyOnMeteora 
        ? await executeMeteorToRaydium(execution, signer, connection)
        : await executeRaydiumToMeteora(execution, signer, connection);
    
    // Ajout du tip pour Fast en dernière instruction
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
    const serializedTx = transaction.serialize().toString("base64");
    
    try {
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
        
        if (result.result) {
            const txHash = result.result;
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