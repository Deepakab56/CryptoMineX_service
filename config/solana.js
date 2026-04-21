import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";

const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync("id.json")))
);

const connection = new Connection(
    "https://devnet.helius-rpc.com/?api-key=90a14e42-adc7-4c07-a21c-da936aca4d84",
    "confirmed"
);

const wallet = new anchor.Wallet(keypair);
const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
});
anchor.setProvider(provider);

// ✅ Simple — no normalization needed
const idl = JSON.parse(fs.readFileSync("./idl/example.json", "utf-8"));
const program = new anchor.Program(idl, provider);

export { connection, keypair, provider, program };