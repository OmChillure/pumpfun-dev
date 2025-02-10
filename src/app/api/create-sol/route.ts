import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { PumpFunSDK } from "pumpdotfun-sdk";
import { AnchorProvider } from "@coral-xyz/anchor";
import { printSPLBalance } from "@/utils/util";
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createTransferInstruction } from "@solana/spl-token";
import clientPromise from '@/utils/db';
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds
const TRANSACTION_TIMEOUT = 120000; // 2 minutes
const SLIPPAGE_BASIS_POINTS = BigInt(100);

async function getBlockhashWithRetry(
  connection: Connection,
  retries = MAX_RETRIES
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  for (let i = 0; i < retries; i++) {
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("finalized");
      return {
        blockhash,
        lastValidBlockHeight: lastValidBlockHeight + 150,
      };
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
  throw new Error("Failed to get blockhash after retries");
}

//function to transfer token
async function transferTokensToConnectedWallet(
  connection: Connection,
  mint: PublicKey,
  fromWallet: Keypair,
  toWalletPubkey: PublicKey
) {
  try {
    const fromTokenAccount = await getAssociatedTokenAddress(
      mint,
      fromWallet.publicKey
    );

    const toTokenAccount = await getAssociatedTokenAddress(
      mint,
      toWalletPubkey
    );

    const transaction = new Transaction();
    const toTokenAccountInfo = await connection.getAccountInfo(toTokenAccount);
    if (!toTokenAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromWallet.publicKey, 
          toTokenAccount,  
          toWalletPubkey, 
          mint              
        )
      );
    }

    const fromBalance = await connection.getTokenAccountBalance(fromTokenAccount);
    if (!fromBalance?.value?.amount) {
      throw new Error("Could not get token balance");
    }

    transaction.add(
      createTransferInstruction(
        fromTokenAccount,        
        toTokenAccount,          
        fromWallet.publicKey,     
        BigInt(fromBalance.value.amount)
      )
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = fromWallet.publicKey;

    transaction.sign(fromWallet);
    const signature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(signature);

    return signature;
  } catch (error) {
    console.error("Error transferring tokens:", error);
    throw error;
  }
}


export async function POST(req: NextRequest) {
  let filePath: string | null = null;
  let connection: Connection | null = null;

  try {
    console.log("Starting token creation process...");

    const data = await req.formData();
    console.log("Form data received");

    const walletDataRaw = data.get("walletData");
    if (!walletDataRaw) throw new Error("No wallet data provided");

    const walletData = JSON.parse(walletDataRaw as string);
    
    //mongo client
    const mongoClient = await clientPromise;
    const db = mongoClient.db('tokenDb');
    const keysCollection = db.collection('keys');

    const storedKeys = await keysCollection.findOne({ walletId: walletData.id });
    if (!storedKeys) {
      throw new Error("Wallet keys not found");
    }
    
    const keypair = Keypair.fromSecretKey(new Uint8Array(storedKeys.keypair.buffer));
    const mint = Keypair.fromSecretKey(new Uint8Array(storedKeys.mint.buffer));

    let retryCount = 0;
    while (!connection && retryCount < MAX_RETRIES) {
      try {
        connection = new Connection(process.env.NEXT_PUBLIC_HELIUS_RPC_URL!, {
          commitment: "finalized",
          confirmTransactionInitialTimeout: TRANSACTION_TIMEOUT,
          wsEndpoint: process.env.NEXT_PUBLIC_HELIUS_WS_URL,
        });
        console.log("Connection established");
      } catch (e) {
        retryCount++;
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
    if (!connection) throw new Error("Failed to establish connection");


    console.log("Created Keypairs:");
    console.log("Main Keypair:", {
      publicKey: keypair.publicKey.toString(),
    });
    console.log("Mint Keypair:", {
      publicKey: mint.publicKey.toString(),
    });
    
    console.log("Keypairs created");


    console.log("Checking initial balance...");

    // Create wallet instance for provider
    const walletInstance = {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(
          connection!
        );
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.partialSign(keypair);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(
          connection!
        );
        return txs.map((t) => {
          t.recentBlockhash = blockhash;
          t.lastValidBlockHeight = lastValidBlockHeight;
          t.partialSign(keypair);
          return t;
        });
      },
    };

    const provider = new AnchorProvider(connection, walletInstance as any, {
      commitment: "finalized",
      preflightCommitment: "finalized",
    });
    const sdk = new PumpFunSDK(provider);
    console.log("SDK initialized");

    const imageUrl = data.get("imageUrl") as string;
    console.log("Fetching image from URL:", imageUrl);
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }
    const imageBlob = await imageResponse.blob();

    const tokenMetadata = {
      name: data.get("tokenName") as string,
      symbol: data.get("tokenSymbol") as string,
      description: data.get("tokenDescription") as string,
      file: imageBlob,
      twitter: data.get("twitterLink")?.toString(),
      website: data.get("websiteLink")?.toString(),
      telegram: data.get("telegramLink")?.toString(),
    };
  
    console.log("Token metadata prepared");

    // Create token with retry logic
    console.log("Creating token...");
    let createResults;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        createResults = await sdk.createAndBuy(
          keypair,
          mint,
          tokenMetadata,
          BigInt(3.1  * LAMPORTS_PER_SOL),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: 250000,
            unitPrice: 250000,
          }
        );

        if (createResults.success) {
          console.log("Token creation successful on attempt", i + 1);
          break;
        }
      } catch (error) {
        console.error(`Token creation attempt ${i + 1} failed:`, error);
        if (i === MAX_RETRIES - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }

    if (!createResults?.success) {
      throw new Error("Token creation failed after all retries");
    }

    const tokenUrl = `https://pump.fun/${mint.publicKey.toBase58()}`;
    console.log("Success:", tokenUrl);
    await printSPLBalance(sdk.connection, mint.publicKey, keypair.publicKey);

    return NextResponse.json({ success: true, tokenUrl });
  } catch (error) {
    console.error("Error creating token:", {
      error,
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to create token",
        details: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log("Temporary file cleaned up");
      } catch (error) {
        console.error("Error cleaning up temporary file:", error);
      }
    }
  }
}