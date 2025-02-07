import { NextRequest, NextResponse } from "next/server";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import clientPromise from '@/utils/db';

export async function POST(req: NextRequest) {
  try {
    const mongoClient = await clientPromise;
    const db = mongoClient.db('tokenDb');
    const keysCollection = db.collection('keys');

    const newKeypair = Keypair.generate();
    const mintKeypair = Keypair.generate();

    const BASE_AMOUNT = 3.125 * LAMPORTS_PER_SOL;
    const AMOUNT_NEEDED = BASE_AMOUNT;

    const walletId = crypto.randomUUID();

    await keysCollection.insertOne({
      walletId,
      keypair: Buffer.from(newKeypair.secretKey),
      mint: Buffer.from(mintKeypair.secretKey),
      publicKey: newKeypair.publicKey.toBase58(),
      mintPublicKey: mintKeypair.publicKey.toBase58(),
      createdAt: new Date()
    });

    const walletInfo = {
      id: walletId,
      publicKey: newKeypair.publicKey.toBase58(),
      mintPublicKey: mintKeypair.publicKey.toBase58(),
      requiredAmount: AMOUNT_NEEDED / LAMPORTS_PER_SOL,
    };

    return NextResponse.json({ 
      success: true, 
      data: walletInfo 
    });

  } catch (error) {
    console.error("Error generating wallet:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to generate wallet" },
      { status: 500 }
    );
  }
}