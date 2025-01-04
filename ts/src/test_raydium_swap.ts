import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import * as dotenv from "dotenv";
import bs58 from "bs58";

dotenv.config();

// Constants
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const RAYDIUM_SOL_USDC_POOL = new PublicKey("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
const RAYDIUM_PROGRAM_ID = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

async function main() {
    // Configuration
    const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
    console.log(`\nConnexion au RPC: ${RPC_ENDPOINT}`);
    
    const connection = new Connection(RPC_ENDPOINT, {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000
    });

    // Charger le wallet
    if (!process.env.WALLET_PRIVATE_KEY) {
        throw new Error("WALLET_PRIVATE_KEY non définie dans .env");
    }
    const privateKey = bs58.decode(process.env.WALLET_PRIVATE_KEY);
    const signer = Keypair.fromSecretKey(privateKey);
    console.log(`Wallet: ${signer.publicKey.toString()}`);

    try {
        // Créer une nouvelle transaction
        const transaction = new Transaction();

        // Ajouter le compute budget
        const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
            units: 1_400_000
        });
        transaction.add(computeBudgetIx);

        // TODO: Ajouter les instructions de swap ici
        // Pour l'instant, on va juste afficher les informations de la pool

        console.log("\nInformations de la pool Raydium SOL/USDC:");
        console.log(`Pool ID: ${RAYDIUM_SOL_USDC_POOL.toString()}`);
        console.log(`USDC Mint: ${USDC_MINT.toString()}`);
        console.log(`WSOL Mint: ${NATIVE_MINT.toString()}`);
        console.log(`Program ID: ${RAYDIUM_PROGRAM_ID.toString()}`);

        // Récupérer les informations de la pool
        const poolInfo = await connection.getAccountInfo(RAYDIUM_SOL_USDC_POOL);
        if (!poolInfo) {
            throw new Error("Pool non trouvée");
        }
        console.log(`Pool existe: ${poolInfo !== null}`);
        console.log(`Pool data size: ${poolInfo.data.length} bytes`);

    } catch (error) {
        console.error("Erreur:", error);
    }
}

main(); 