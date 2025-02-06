import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { PumpFunSDK } from "pumpdotfun-sdk";
import { AnchorProvider } from "@coral-xyz/anchor";
import { getFile, upload } from "@/app/actions";
import { printSPLBalance } from "@/utils/util";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";



const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds
const TRANSACTION_TIMEOUT = 120000; // 2 minutes
const MINIMUM_BALANCE_REQUIRED = 0.01 * LAMPORTS_PER_SOL;
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

async function waitForBalance(
  connection: Connection,
  publicKey: PublicKey,
  expectedBalance: number,
  maxAttempts = 10
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const balance = await connection.getBalance(publicKey);
    if (balance >= expectedBalance) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function POST(req: NextRequest) {
  let filePath: string | null = null;
  let connection: Connection | null = null;

  try {
    console.log("Starting token creation process...");

    const data = await req.formData();
    console.log("Form data received");

    const uploadResult = await upload(data);
    console.log("File uploaded to IPFS:", uploadResult.hash);

    const walletDataRaw = data.get("walletData");
    if (!walletDataRaw) throw new Error("No wallet data provided");

    const walletData = JSON.parse(walletDataRaw as string);
    console.log("Wallet data parsed successfully");

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

    // Create keypairs from wallet data
    const keypair = Keypair.fromSecretKey(Uint8Array.from(walletData.keypair));
    const mint = Keypair.fromSecretKey(Uint8Array.from(walletData.mint));
    console.log("Created Keypairs:");
    console.log("Main Keypair:", {
      publicKey: keypair.publicKey.toString(),
    });
    console.log("Mint Keypair:", {
      publicKey: mint.publicKey.toString(),
    });

    console.log("Keypairs created");

    //balance
    console.log("Checking initial balance...");
    const hasBalance = await waitForBalance(
      connection,
      keypair.publicKey,
      MINIMUM_BALANCE_REQUIRED
    );
    if (!hasBalance) {
      throw new Error(
        `Insufficient balance after waiting. Required: ${
          MINIMUM_BALANCE_REQUIRED / LAMPORTS_PER_SOL
        } SOL`
      );
    }

    const balance = await connection.getBalance(keypair.publicKey);
    console.log("Confirmed wallet balance:", balance / LAMPORTS_PER_SOL, "SOL");

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

    // Initialize provider and SDK
    const provider = new AnchorProvider(connection, walletInstance as any, {
      commitment: "finalized",
      preflightCommitment: "finalized",
    });
    const sdk = new PumpFunSDK(provider);
    console.log("SDK initialized");

    // Prepare token metadata
    const ipfsData = await getFile(
      uploadResult.hash,
      "application/octet-stream"
    );
    const fileBlob = new Blob([JSON.stringify(ipfsData)], {
      type: "application/octet-stream",
    });

    const tokenMetadata = {
      name: data.get("tokenName") as string,
      symbol: data.get("tokenSymbol") as string,
      description: data.get("tokenDescription") as string,
      file: await fileBlob,
      properties: {
        links: {
          twitter: data.get("twitterLink") || undefined,
          website: data.get("websiteLink") || undefined,
          telegram: data.get("telegramLink") || undefined,
        },
      },
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
          BigInt(0.0001 * LAMPORTS_PER_SOL),
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
    console.log("Success:", `https://pump.fun/${mint.publicKey.toBase58()}`);
    printSPLBalance(sdk.connection, mint.publicKey, keypair.publicKey);
    

    // Execute additional buy transaction
    console.log("Executing additional buy transaction...");
    if (!process.env.NEXT_PUBLIC_BUY_BACK_PRIVATE_KEY)
      throw new Error("Buyer private key not found");

    const buyerKeypair = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(process.env.NEXT_PUBLIC_BUY_BACK_PRIVATE_KEY)));
    console.log("Buyer public key:", buyerKeypair.publicKey.toString());

    let buyResults;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        buyResults = await sdk.buy(
          buyerKeypair,
          mint.publicKey,
          BigInt(3.1 * LAMPORTS_PER_SOL),
          SLIPPAGE_BASIS_POINTS
        );

        if (buyResults.success) {
          console.log(
            "Additional buy transaction successful on attempt",
            i + 1
          );
          break;
        }
      } catch (error) {
        console.error(`Buy attempt ${i + 1} failed:`, error);
        if (i === MAX_RETRIES - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      }
    }

    if (!buyResults?.success) {
      throw new Error("Additional buy transaction failed after all retries");
    }
    await printSPLBalance(sdk.connection, mint.publicKey, keypair.publicKey);
    await printSPLBalance(
      sdk.connection,
      mint.publicKey,
      buyerKeypair.publicKey
    );

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
