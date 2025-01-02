import { Connection, PublicKey } from "@solana/web3.js";
import { TokenAccount } from "@raydium-io/raydium-sdk";
import axios from "axios";
import BN from 'bn.js';

export async function getWalletTokenAccount(
    connection: Connection,
    walletPublicKey: PublicKey
): Promise<TokenAccount[]> {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPublicKey, {
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
    });

    return tokenAccounts.value.map(t => ({
        programId: t.account.owner,
        pubkey: t.pubkey,
        accountInfo: {
            mint: new PublicKey(t.account.data.parsed.info.mint),
            owner: new PublicKey(t.account.data.parsed.info.owner),
            amount: new BN(t.account.data.parsed.info.tokenAmount.amount),
            delegateOption: 0,
            delegate: new PublicKey("11111111111111111111111111111111"),
            state: 1,
            isNativeOption: 0,
            isNative: new BN(0),
            delegatedAmount: new BN(t.account.data.parsed.info.delegatedAmount?.amount || 0),
            closeAuthorityOption: 0,
            closeAuthority: new PublicKey("11111111111111111111111111111111")
        }
    }));
}

export async function formatAmmKeysById(poolId: string) {
    const { data } = await axios.get(`https://api.raydium.io/v2/main/pairs`);
    return data.find((pool: any) => pool.ammId === poolId);
} 