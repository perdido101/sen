#!/usr/bin/env node
/**
 * Create the devnet SPL mint and print the two addresses the server needs.
 *
 *   node tools/token-init.mjs [keypair.json]
 *
 * Run once, on a machine with internet access, against devnet. It does three
 * things and stops: fund the payer if it is empty, create a mint with the
 * published supply and decimals, and mint the whole supply to the payer's
 * token account. It does not write to the repo, it does not touch the running
 * server, and it prints the environment variables rather than setting them,
 * because a script that silently edits a deployment's configuration is a
 * script nobody can audit afterwards.
 *
 * Mint authority is retained. That is a deliberate, published position: it
 * exists for the scheduled airdrops in Phase 18 and is stated on /treasury
 * rather than discovered later. Revoking it would end the airdrop programme.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, clusterApiUrl } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

const CLUSTER = process.env.SEN_SOLANA_CLUSTER ?? 'devnet';
if (CLUSTER !== 'devnet' && CLUSTER !== 'testnet') {
  console.error(`refusing to run against "${CLUSTER}". This script is devnet/testnet only.`);
  process.exit(1);
}

// Must match TOKEN_TERMS in apps/server/src/token.ts. They are published.
const SUPPLY = 1_000_000_000;
const DECIMALS = 9;

const path = process.argv[2] ?? '.secrets/treasury.json';

let payer;
if (existsSync(path)) {
  payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
  console.log(`loaded treasury keypair from ${path}`);
} else {
  payer = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(payer.secretKey)));
  console.log(`generated a new treasury keypair at ${path}`);
  console.log('  This file is the treasury. It must never enter the repository.');
}

const rpc = process.env.SEN_SOLANA_RPC ?? clusterApiUrl(CLUSTER);
const conn = new Connection(rpc, 'confirmed');
console.log(`cluster ${CLUSTER} via ${rpc}`);
console.log(`treasury ${payer.publicKey.toBase58()}`);

let balance = await conn.getBalance(payer.publicKey);
if (balance < 0.5 * LAMPORTS_PER_SOL) {
  console.log('requesting an airdrop of 1 SOL ...');
  const sig = await conn.requestAirdrop(payer.publicKey, LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, 'confirmed');
  balance = await conn.getBalance(payer.publicKey);
}
console.log(`balance ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);

console.log('creating mint ...');
const mint = await createMint(conn, payer, payer.publicKey, payer.publicKey, DECIMALS);
console.log(`mint ${mint.toBase58()}`);

const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
console.log(`treasury token account ${ata.address.toBase58()}`);

console.log(`minting ${SUPPLY.toLocaleString('en-US')} tokens ...`);
const sig = await mintTo(conn, payer, mint, ata.address, payer, BigInt(SUPPLY) * BigInt(10 ** DECIMALS));
console.log(`https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`);

console.log('');
console.log('Set these on the server and restart it:');
console.log('');
console.log(`  SEN_SOLANA_CLUSTER=${CLUSTER}`);
console.log(`  SEN_TOKEN_MINT=${mint.toBase58()}`);
console.log(`  SEN_TREASURY_PUBKEY=${payer.publicKey.toBase58()}`);
console.log(`  SEN_TREASURY_KEYPAIR=${path}`);
console.log('');
console.log('Mint authority is retained for scheduled airdrops, and /treasury says so.');
