import { NextResponse } from 'next/server';
import { Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction, Keypair, PublicKey } from "@solana/web3.js";
import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";

const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "";
const BASE_AMOUNT = 0.030 * LAMPORTS_PER_SOL;
const AGENT_WALLET = process.env.NEXT_PUBLIC_AGENT_WALLET;

async function generateWallet() {
  const response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/generate-wallet`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Failed to generate wallet");
  }

  return result.data;
}

async function storeTokenData(
  tokenName: string,
  tokenSymbol: string,
  tokenDesc: string,
  twitterLink: string,
  websiteLink: string,
  telegramLink: string,
  fundingSignature: string,
  fundingWallet: string,
  imageUrl: string,
  targetWallet: string,
  solAmount: string,
) {
  const tokenData = {
    tokenName,
    tokenSymbol,
    tokenDescription: tokenDesc,
    twitterLink,
    websiteLink,
    telegramLink,
    fundingSignature,
    fundingWallet,
    image: imageUrl,
    targetWallet,
    solAmount
  };

  const response = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenData),
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error("Failed to store token data");
  }

  return result.tokenId;
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const apiKey = process.env.NEXT_PUBLIC_PY_API_KEY;

    if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const data = await request.json();
    console.log('Received memecoin data:', data);

    const walletInfo = await generateWallet();

    const connection = new Connection(RPC_URL, {
      commitment: "finalized",
      confirmTransactionInitialTimeout: 120000,
    });

    if (!AGENT_WALLET) throw new Error("Agent wallet not configured");
    const agentKeypair = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(AGENT_WALLET)));

    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: agentKeypair.publicKey,
        toPubkey: new PublicKey(walletInfo.publicKey),
        lamports: BASE_AMOUNT,
      })
    );

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
    transaction.feePayer = agentKeypair.publicKey;

    transaction.sign(agentKeypair);
    
    const fundingSignature = await connection.sendRawTransaction(transaction.serialize());
    await connection.confirmTransaction(fundingSignature);

    const tokenId = await storeTokenData(
      data.memecoin.name,       
      data.memecoin.ticker,       
      data.memecoin.description,   
      "",                           
      "",                      
      "",                  
      fundingSignature,
      agentKeypair.publicKey.toString(),
      "https://assets.agent.playai.network/avatar/8061bae9-e5c8-4a38-aba4-4ea9bed6fa8b.jpg?timestamp=1738936193488",   
      walletInfo.publicKey,
      "0.001"                    
    );

    const tokenResponse = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/create-sol`, {
      method: "POST",
      body: JSON.stringify({
        imageUrl: "https://assets.agent.playai.network/avatar/8061bae9-e5c8-4a38-aba4-4ea9bed6fa8b.jpg?timestamp=1738936193488", 
        tokenName: data.memecoin.name,
        tokenSymbol: data.memecoin.ticker,
        tokenDescription: data.memecoin.description,
        fundingSignature,
        fundingWallet: agentKeypair.publicKey.toString(),
        tokenId,
        solAmount: "0.001",
        twitterLink: "",
        websiteLink: "",
        telegramLink: "",
      }),
    });

    const result = await tokenResponse.json();
    if (!result.success) {
      throw new Error(result.error);
    }

    return NextResponse.json({ 
      message: 'Token created successfully',
      tokenId,
      walletInfo 
    });

  } catch (error) {
    console.error('Error processing memecoin:', error);
    return NextResponse.json({ error: 'Token creation failed' }, { status: 500 });
  }
}