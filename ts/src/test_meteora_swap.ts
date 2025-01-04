import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, createInitializeAccountInstruction, createSyncNativeInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import * as dotenv from "dotenv";
import bs58 from "bs58";
import { BN } from 'bn.js';
import DLMM from '@meteora-ag/dlmm';
import * as readline from 'readline';
import axios from 'axios';

dotenv.config();

// Constants
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOL_MINT = NATIVE_MINT;
const LAMPORTS_PER_SOL = 1_000_000_000;
const AMOUNT_IN = new BN(10_000_000); // 0.01 SOL en lamports (10 millions de lamports)

// Liste des pools DLMM connues (fallback si l'API ne répond pas)
const KNOWN_POOLS = [
    {
        address: new PublicKey("7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm"),
        name: "Meteora DLMM SOL-USDC Pool #1",
        description: "Pool DLMM principale SOL/USDC",
        tvl: "1000000",
        volume24h: "500000"
    },
    {
        address: new PublicKey("BRCKvXVdjuHrqfHPXrEv91Vn5hiMZHBPQf4NhxJ4r4NK"),
        name: "Meteora DLMM SOL-USDC Pool #2",
        description: "Pool DLMM alternative SOL/USDC",
        tvl: "500000",
        volume24h: "250000"
    }
];

interface DlmmPool {
    address: string;
    name: string;
    liquidity: string;
    trade_volume_24h: number;
    base_fee_percentage: string;
    current_price: number;
    mint_x: string;
    mint_y: string;
}

interface PoolInfo {
    address: PublicKey;
    name: string;
    description: string;
    tvl: string;
    volume24h: string;
    fees: string;
    currentPrice: number;
}

async function fetchAllPools(): Promise<PoolInfo[]> {
    try {
        console.log("Récupération des pools depuis l'API DLMM...");
        
        // Utiliser l'API DLMM spécifique
        const response = await axios.get('https://dlmm-api.meteora.ag/pair/all');
        const pools: DlmmPool[] = response.data;
        console.log(`${pools.length} pools trouvées au total`);
        
        // Filtrer pour ne garder que les pools SOL/USDC
        const solUsdcPools = pools.filter(pool => {
            const hasSOL = pool.mint_x === SOL_MINT.toString() || pool.mint_y === SOL_MINT.toString();
            const hasUSDC = pool.mint_x === USDC_MINT.toString() || pool.mint_y === USDC_MINT.toString();
            return hasSOL && hasUSDC;
        });
        
        console.log(`${solUsdcPools.length} pools SOL/USDC trouvées`);
        
        // Convertir au format attendu
        return solUsdcPools.map(pool => ({
            address: new PublicKey(pool.address),
            name: pool.name,
            description: `Pool DLMM avec TVL: $${pool.liquidity}, Volume 24h: $${pool.trade_volume_24h}`,
            tvl: pool.liquidity,
            volume24h: pool.trade_volume_24h.toString(),
            fees: pool.base_fee_percentage,
            currentPrice: pool.current_price
        }));

    } catch (error) {
        console.log("Impossible de récupérer les pools depuis l'API DLMM, utilisation de la liste locale...");
        return [
            {
                address: new PublicKey("8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu"),
                name: "SOL-USDC Pool (Principal)",
                description: "Pool DLMM SOL/USDC principale",
                tvl: "5000000",
                volume24h: "1000000",
                fees: "0.1",
                currentPrice: 0
            }
        ];
    }
}

function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

async function choosePool(pools: PoolInfo[]): Promise<PublicKey> {
    return new Promise((resolve) => {
        const rl = createReadlineInterface();
        
        console.log("\nPools DLMM SOL/USDC disponibles:");
        pools.forEach((pool, index) => {
            console.log(`\n[${index + 1}] ${pool.name}`);
            console.log(`    Adresse: ${pool.address.toString()}`);
            console.log(`    Description: ${pool.description}`);
            console.log(`    TVL: $${pool.tvl}`);
            console.log(`    Volume 24h: $${pool.volume24h}`);
            console.log(`    Frais: ${pool.fees}%`);
            if (pool.currentPrice) {
                console.log(`    Prix actuel: $${pool.currentPrice}`);
            }
        });

        rl.question('\nChoisissez le numéro de la pool à utiliser (1-' + pools.length + '): ', (answer) => {
            rl.close();
            const index = parseInt(answer) - 1;
            if (index >= 0 && index < pools.length) {
                resolve(pools[index].address);
            } else {
                console.log("Choix invalide, utilisation de la première pool");
                resolve(pools[0].address);
            }
        });
    });
}

async function executeSwap(connection: Connection, signer: Keypair, poolAddress: PublicKey) {
    // Vérifier le solde du wallet
    const balance = await connection.getBalance(signer.publicKey);
    const amountNeeded = AMOUNT_IN.toNumber() + (0.01 * LAMPORTS_PER_SOL);
    
    if (balance < amountNeeded) {
        throw new Error(`Solde insuffisant. Vous avez ${balance / LAMPORTS_PER_SOL} SOL, besoin de ${amountNeeded / LAMPORTS_PER_SOL} SOL minimum`);
    }

    console.log(`\nPréparation du swap de ${AMOUNT_IN.toNumber() / LAMPORTS_PER_SOL} SOL vers USDC`);
    console.log(`Pool utilisée: ${poolAddress.toString()}`);
    console.log(`Solde actuel: ${balance / LAMPORTS_PER_SOL} SOL`);

    // Vérifier que la pool existe
    console.log("\nVérification de la pool...");
    const accountInfo = await connection.getAccountInfo(poolAddress);
    if (!accountInfo) {
        throw new Error(`La pool ${poolAddress.toString()} n'existe pas sur la blockchain`);
    }
    console.log("Pool trouvée !");

    // Créer l'instance de la pool DLMM
    const dlmmPool = await DLMM.create(connection, poolAddress);
    
    // Obtenir les bin arrays pour le swap
    console.log("\nRécupération des bin arrays...");
    const binArrays = await dlmmPool.getBinArrayForSwap(true); // true pour SOL -> USDC

    // Obtenir le quote pour le swap
    console.log("\nCalcul du quote...");
    const swapQuote = await dlmmPool.swapQuote(
        AMOUNT_IN,
        true, // true pour SOL -> USDC
        new BN(50), // 0.5% de slippage (50 bps)
        binArrays
    );
    console.log(`Quote minimum: ${swapQuote.minOutAmount.toString()} USDC`);

    // Créer la transaction
    const transaction = new Transaction();

    // Ajouter l'instruction de compute budget
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: 114585
    });
    transaction.add(computeBudgetIx);

    // Créer un compte WSOL temporaire
    const wsolAccount = Keypair.generate();
    const rent = await connection.getMinimumBalanceForRentExemption(165);
    const createWsolAccountIx = SystemProgram.createAccount({
        fromPubkey: signer.publicKey,
        newAccountPubkey: wsolAccount.publicKey,
        lamports: AMOUNT_IN.toNumber() + rent,
        space: 165,
        programId: TOKEN_PROGRAM_ID
    });
    transaction.add(createWsolAccountIx);

    // Initialiser le compte WSOL
    const initWsolAccountIx = createInitializeAccountInstruction(
        wsolAccount.publicKey,
        SOL_MINT,
        signer.publicKey
    );
    transaction.add(initWsolAccountIx);

    // Synchroniser le compte WSOL
    const syncNativeIx = createSyncNativeInstruction(wsolAccount.publicKey);
    transaction.add(syncNativeIx);

    // Créer l'instruction de swap
    const swapTx = await dlmmPool.swap({
        inToken: SOL_MINT,
        outToken: USDC_MINT,
        binArraysPubkey: swapQuote.binArraysPubkey,
        inAmount: AMOUNT_IN,
        lbPair: dlmmPool.pubkey,
        user: signer.publicKey,
        minOutAmount: swapQuote.minOutAmount
    });
    transaction.add(...swapTx.instructions);

    // Fermer le compte WSOL temporaire
    const closeWsolAccountIx = createCloseAccountInstruction(
        wsolAccount.publicKey,
        signer.publicKey,
        signer.publicKey
    );
    transaction.add(closeWsolAccountIx);

    // Finaliser et envoyer la transaction
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    transaction.feePayer = signer.publicKey;
    transaction.sign(signer, wsolAccount);

    console.log("\nEnvoi de la transaction...");
    const txid = await connection.sendRawTransaction(transaction.serialize());
    console.log(`Transaction envoyée: https://solscan.io/tx/${txid}`);

    // Attendre la confirmation
    console.log("\nAttente de la confirmation...");
    await connection.confirmTransaction(txid);
    console.log("Transaction confirmée !");
}

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
        // Récupérer toutes les pools disponibles
        const availablePools = await fetchAllPools();
        
        // Laisser l'utilisateur choisir la pool
        const selectedPoolAddress = await choosePool(availablePools);
        const selectedPool = availablePools.find(p => p.address.equals(selectedPoolAddress));
        console.log(`\nPool sélectionnée: ${selectedPool?.name}`);

        // Exécuter le swap
        await executeSwap(connection, signer, selectedPoolAddress);

    } catch (error) {
        console.error("Erreur:", error);
    }
}

main(); 