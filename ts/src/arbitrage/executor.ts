import { 
    Connection, 
    PublicKey, 
    Transaction, 
    SystemProgram,
    TransactionInstruction,
    Keypair, 
    ComputeBudgetProgram
} from "@solana/web3.js";
import { FAST_API_KEY } from "../config.js";
import { NATIVE_MINT } from "@solana/spl-token";
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
    MAINNET_PROGRAM_ID
} from "@raydium-io/raydium-sdk";
import { AmmImpl } from "@mercurial-finance/dynamic-amm-sdk";

// Constants pour Fast
const FAST_URL = "https://fast.circular.bot/transactions";
const FAST_TIP = new PublicKey("FAST3dMFZvESiEipBvLSiXq3QCV51o3xuoHScqRU6cB6");
const MIN_TIP_AMOUNT = 1_000_000; // 0.001 SOL

// Constants pour la sécurité
const MIN_PROFIT_BPS = 50; // 0.5% de profit minimum
const MAX_PRICE_IMPACT_BPS = 100; // 1% d'impact prix maximum
const SLIPPAGE_BPS = 100; // 1% de slippage maximum

// Constants pour Raydium
const RAYDIUM_PROGRAM_IDS = {
    4: new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    5: new PublicKey("5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h")
};

// Constants pour Meteora
const METEORA_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

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

        // Initialiser le pool Meteora
        const pool = await AmmImpl.create(
            connection,
            METEORA_PROGRAM_ID,
            new PublicKey(poolId),
            { commitment: 'confirmed' }
        );

        // Convertir le montant en lamports
        const amountInLamports = Math.floor(amountIn * 1e9);

        // Obtenir les instructions de swap
        const { instructions } = await pool.swap(
            new BN(amountInLamports),
            isWsolToToken ? NATIVE_MINT : new PublicKey(tokenAddress),
            isWsolToToken ? new PublicKey(tokenAddress) : NATIVE_MINT,
            signer.publicKey,
            SLIPPAGE_BPS
        );

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
        // Obtenir les informations du pool
        const allPoolKeys = await Liquidity.fetchAllPoolKeys(connection, RAYDIUM_PROGRAM_IDS);
        const poolKeys = allPoolKeys.find(pool => pool.id.toString() === poolId);
        
        if (!poolKeys) {
            throw new Error(`Pool non trouvé: ${poolId}`);
        }

        // Créer le token
        const token = new Token(TOKEN_PROGRAM_ID, new PublicKey(tokenAddress), 9);
        const amountInValue = new TokenAmount(token, amountIn);

        // Créer les instructions de swap
        const swapParams = {
            connection,
            poolKeys,
            userKeys: {
                tokenAccounts: [], // Sera rempli automatiquement
                owner: signer.publicKey,
            },
            amountIn: amountInValue,
            amountOut: new TokenAmount(token, 0), // Sera calculé par le SDK
            fixedSide: "in" as const,
            tokenMint: isWsolToToken ? NATIVE_MINT : new PublicKey(tokenAddress),
            makeTxVersion: TxVersion.V0
        };

        const { innerTransactions } = await Liquidity.makeSwapInstructionSimple(swapParams);
        
        // Extraire toutes les instructions
        const instructions: TransactionInstruction[] = [];
        for (const innerTx of innerTransactions) {
            instructions.push(...innerTx.instructions);
        }

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

    // 1. Swap WSOL -> Token sur Raydium
    const raydiumInstructions = await createRaydiumSwapInstructions(
        execution.raydiumPoolId,
        execution.amountIn,
        true,
        signer,
        execution.tokenAddress,
        connection
    );
    
    // 2. Swap Token -> WSOL sur Meteora
    const meteoraInstructions = await createMeteoraSwapInstructions(
        execution.meteoraPoolId,
        execution.amountIn,
        false,
        signer,
        connection,
        execution.tokenAddress
    );

    // Ajouter les instructions dans l'ordre
    transaction.add(
        ...raydiumInstructions,
        ...meteoraInstructions
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

    // 1. Swap WSOL -> Token sur Meteora
    const meteoraInstructions = await createMeteoraSwapInstructions(
        execution.meteoraPoolId,
        execution.amountIn,
        true,
        signer,
        connection,
        execution.tokenAddress
    );

    // 2. Swap Token -> WSOL sur Raydium
    const raydiumInstructions = await createRaydiumSwapInstructions(
        execution.raydiumPoolId,
        execution.amountIn,
        false,
        signer,
        execution.tokenAddress,
        connection
    );

    // Ajouter les instructions dans l'ordre
    transaction.add(
        ...meteoraInstructions,
        ...raydiumInstructions
    );
    
    return transaction;
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