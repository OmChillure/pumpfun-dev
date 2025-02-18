import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import axios from "axios";
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
import { ObjectId } from "mongodb";

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


async function fetchPriceWithRetry(mintAddress: string, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Attempt ${i + 1} to fetch price for ${mintAddress}`);
      const response = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`
      );
      const data = response.data;
      const price = parseFloat(data?.pairs?.[0]?.priceNative);
      
      if (price && price > 0) { 
        console.log(`Successfully got price on attempt ${i + 1}: ${price}`);
        return price;
      }
      
      console.log(`No valid price found on attempt ${i + 1}, waiting before retry...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    } catch (error) {
      console.error(`Attempt ${i + 1} failed:`, error);
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  return null;
}


export async function POST(req: NextRequest) {
  let filePath: string | null = null;
  let connection: Connection | null = null;

  try {
    console.log("Starting token creation process...");
    const data = await req.json();
    console.log("Received data:", data);

    const {
      fundingSignature,
      tokenId,
      solAmount,
      tokenName,
      tokenSymbol,
      tokenDescription,
      imageUrl,
      twitterLink,
      websiteLink,
      telegramLink
    } = data;

    if (!fundingSignature || !tokenId || !solAmount) {
      throw new Error("Missing required data");
    }


    connection = new Connection(process.env.NEXT_PUBLIC_HELIUS_RPC_URL!, {
      commitment: "finalized",
      confirmTransactionInitialTimeout: TRANSACTION_TIMEOUT,
      wsEndpoint: process.env.NEXT_PUBLIC_HELIUS_WS_URL,
    });

    const tx = await connection.getTransaction(fundingSignature as string, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0
    });

    if (!tx) {
      throw new Error("Transaction not found");
    }

    const mongoClient = await clientPromise;
    const db = mongoClient.db('tokenDb');

    const tokensCollection = db.collection('tokens');
    const storedToken = await tokensCollection.findOne({
      _id: new ObjectId(tokenId),
      fundingSignature: fundingSignature
    });

    if (!storedToken) {
      throw new Error("Token data not found");
    }

    const receiverAddress = tx.transaction.message.getAccountKeys().get(1)?.toBase58();

    const keysCollection = db.collection('keys');
    const storedKeys = await keysCollection.findOne({
      publicKey: receiverAddress
    });

    if (!storedKeys) {
      throw new Error("Receiver is not a valid generated wallet");
    }

    const keypair = Keypair.fromSecretKey(new Uint8Array(storedKeys.keypair.buffer));
    const mint = Keypair.fromSecretKey(new Uint8Array(storedKeys.mint.buffer));

    const TRANSACTION_FEE = 0.003 * LAMPORTS_PER_SOL;


    // Create wallet instance for provider
    const walletInstance = {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: Transaction) => {
        const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(connection!);
        tx.recentBlockhash = blockhash;
        tx.lastValidBlockHeight = lastValidBlockHeight;
        tx.partialSign(keypair);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        const { blockhash, lastValidBlockHeight } = await getBlockhashWithRetry(connection!);
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

    console.log("Fetching image from URL:", imageUrl);
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch image: ${imageResponse.statusText}`);
    }
    const imageBlob = await imageResponse.blob();

    const tokenMetadata = {
      name: tokenName,
      symbol: tokenSymbol,
      description: tokenDescription,
      file: await imageBlob,
      properties: {
        links: {
          twitter: twitterLink || undefined,
          website: websiteLink || undefined,
          telegram: telegramLink || undefined,
        },
      },
    };

    // Create token with retry logic   
    let createResults;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const adjustedAmount = 0.01 - (TRANSACTION_FEE / LAMPORTS_PER_SOL);
        createResults = await sdk.createAndBuy(
          keypair,
          mint,
          tokenMetadata,
          BigInt(adjustedAmount * LAMPORTS_PER_SOL),
          SLIPPAGE_BASIS_POINTS,
          {
            unitLimit: 250000,
            unitPrice: 250000,
          }
        );

        if (createResults.success) {
          console.log("Token creation successful on attempt", i + 1);
          printSPLBalance(connection, mint.publicKey, keypair.publicKey, "Token account balance:");
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

    try {
      console.log("Waiting 10 seconds before fetching initial price...");
      await new Promise(resolve => setTimeout(resolve, 3000));

      const mintAddress = mint.publicKey.toBase58();
      console.log("Fetching initial price for mint:", mintAddress);
      const initialPriceInSol = await fetchPriceWithRetry(mintAddress);

      await tokensCollection.updateOne(
        { _id: new ObjectId(tokenId) },
        {
          $set: {
            tokenUrl,
            initialPriceInSol,
            updatedAt: new Date()
          }
        }
      );

      console.log("Token URL and price saved successfully:", {
        tokenUrl,
        initialPriceInSol
      });

    } catch (error) {
      console.error("Error fetching price from DexScreener:", error);
      await tokensCollection.updateOne(
        { _id: new ObjectId(tokenId) },
        {
          $set: {
            tokenUrl,
            updatedAt: new Date()
          }
        }
      );
    }
    return NextResponse.json({ success: true, tokenUrl });

  } catch (error) {
    console.error("Error creating token:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to create token",
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