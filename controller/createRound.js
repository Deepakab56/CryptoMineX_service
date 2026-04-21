import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { connection, keypair, program } from "../config/solana.js";
import BN from "bn.js"

export const createRound = async () => {
    try {
        // Get Global PDA
        const [globalPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("globals")],
            program.programId
        );

        // Fetch global state to get current round
        const globalState = await program.account.globalState.fetch(globalPda);

        const roundIdBuffer = new BN(globalState.roundId)
            .toArrayLike(Buffer, "le", 8);

        // Derive round PDA
        const [roundPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("round"), roundIdBuffer],
            program.programId
        );

        // Call initializeRound
        const tx = await program.methods
            .initializeRound()
            .accounts({
                signer: keypair.publicKey,
                globalAccount: globalPda,
                roundAccount: roundPda,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        await connection.confirmTransaction(tx, "confirmed");

        console.log("Round Created:", tx);

        // res.json({ success: true, tx });

    } catch (err) {
        console.error(err);
       
    }
}