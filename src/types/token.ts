import { ObjectId } from "mongodb";

export interface WalletInfo {
  id: any;
  name: string;
  publicKey: string;
  balance: number;
  keypair: number[];
  mint: number[];
  tokenUrl?: string;
}

export interface WalletGenerationProgress {
  current: number;
  total: number;
  status: string;
}

export interface TokenData {
  _id?: ObjectId;
  tokenName: string;
  tokenSymbol: string;
  tokenDescription?: string;
  imageUrl?: string;
  twitterLink?: string;
  websiteLink?: string;
  telegramLink?: string;
  wallets: WalletInfo[];
  createdAt?: Date;
  launchInterval: number;
  fundingWallet: string;
}

export interface TokenResponse {
  success: boolean;
  tokenUrl?: string;
  error?: string;
}

export interface StoreResponse {
  success: boolean;
}