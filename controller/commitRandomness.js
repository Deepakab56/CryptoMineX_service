import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { connection, keypair, program } from "../config/solana.js";
import BN from "bn.js"


const SB_DEVNET_PROGRAM_ID = new PublicKey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");

// ✅ Hardcoded devnet queue — no network call needed
const SB_DEVNET_QUEUE = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");

const TX_OPTIONS = {
    computeUnitPrice: 75_000,
    computeUnitLimitMultiple: 1.3,
};

// ✅ No loadEnv(), no fetchIdl(), no network call at startup
async function getSbProgram() {
    const idl = await anchor.Program.fetchIdl(SB_DEVNET_PROGRAM_ID, program.provider);
    if (!idl) throw new Error("Switchboard IDL not found on devnet");
    return new anchor.Program(idl, program.provider);
}

// ── Retry Helpers ─────────────────────────────────────────────────────────────
async function retryCommit(randomness, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await randomness.commitIx(SB_DEVNET_QUEUE);
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function retryReveal(randomness, retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            return await randomness.revealIx();
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

async function getCurrentRound() {
    const [globalPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("globals")],
        program.programId
    );

    const globalState = await program.account.globalState.fetch(globalPda);

    const roundIdBuffer = new BN(globalState.roundId)
        .toArrayLike(Buffer, "le", 8);

    const [roundPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("round"), roundIdBuffer],
        program.programId
    );

    const roundState = await program.account.round.fetch(roundPda);
    const winnerBuffer = Buffer.from([roundState.winnerTicket]);

    const [treasury] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury"), roundIdBuffer],
        program.programId
    );

    const [ticketPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), roundIdBuffer, winnerBuffer],
        program.programId
    );

    return {
        globalPda,
        roundPda,
        roundIdBuffer,  // ✅ needed by ticket_data route
        treasury,
        ticketPda,
        winnerBuffer,
    };
}

export const commitrandomness = async () => {
    try {
        const sbProgram = await getSbProgram(); // ✅ uses your provider, correct program ID

        const rngKp = Keypair.generate();

        const [randomness, createIx] = await sb.Randomness.create(
            sbProgram,
            rngKp,
            SB_DEVNET_QUEUE // ✅ hardcoded, no network call
        );

        // Step 1: Create randomness account
        const createTx = await sb.asV0Tx({
            connection,
            ixs: [createIx],
            payer: keypair.publicKey,
            signers: [keypair, rngKp],
            ...TX_OPTIONS,
        });

        const createSig = await connection.sendTransaction(createTx);
        await connection.confirmTransaction(createSig, "confirmed");
        console.log("Randomness account created:", createSig);

        // Step 2: Commit
        const commitIx = await retryCommit(randomness);
        const { roundPda } = await getCurrentRound();

        const commitProgramIx = await program.methods
            .commitRandomness()
            .accounts({
                signer: keypair.publicKey,
                roundAccount: roundPda,
                randomnessAccountData: rngKp.publicKey,
            })
            .instruction();

        const commitTx = await sb.asV0Tx({
            connection,
            ixs: [commitIx, commitProgramIx],
            payer: keypair.publicKey,
            signers: [keypair],
            ...TX_OPTIONS,
        });

        const sig = await connection.sendTransaction(commitTx);
        await connection.confirmTransaction(sig, "confirmed");
        console.log("Committed:", sig);

        return rngKp.publicKey.toString()

        // res.json({
        //     success: true,
        //     signature: sig,
        //     randomnessPubkey: rngKp.publicKey.toString(),
        // });
    } catch (err) {
        console.error(err);
        // res.status(500).json({ error: err.message });
    }
}