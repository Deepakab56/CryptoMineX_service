import express from "express";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import * as sb from "@switchboard-xyz/on-demand";
import { connection, keypair, program } from "../config/solana.js";
import BN from "bn.js"

const router = express.Router();

// ✅ Correct Program IDs from official docs
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
export async function getCurrentRound() {
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


// create round 
router.post("/create-round", async (req, res) => {
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

        res.json({ success: true, tx });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});


// ── Buy Ticket ────────────────────────────────────────────────────────────────
router.post("/buy-ticket", async (req, res) => {
    try {
        const { ticketNo, amount } = req.body;
        const { globalPda, roundPda } = await getCurrentRound();

        const globalState = await program.account.globalState.fetch(globalPda);
        const roundIdBuffer = new anchor.BN(globalState.roundId)
            .toArrayLike(Buffer, "le", 8);

        const ticketId = new anchor.BN(Date.now());
        const ticketIdBuffer = ticketId.toArrayLike(Buffer, "le", 8);

        const [ticketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("ticket"), roundIdBuffer, ticketIdBuffer],
            program.programId
        );
        const [userTicketPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("user_ticket"), keypair.publicKey.toBuffer(), roundIdBuffer, ticketIdBuffer],
            program.programId
        );
        const [treasuryPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("treasury"), roundIdBuffer],
            program.programId
        );

        const tx = await program.methods
            .buyTicket(ticketNo, new anchor.BN(amount))
            .accounts({
                signer: keypair.publicKey,
                globalAccount: globalPda,
                roundAccount: roundPda,
                ticketAccount: ticketPda,
                userAccount: userTicketPda,
                treasury: treasuryPda,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        res.json({ success: true, tx });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/commit-randomness", async (req, res) => {
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

        res.json({
            success: true,
            signature: sig,
            randomnessPubkey: rngKp.publicKey.toString(),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ── Reveal Winner ─────────────────────────────────────────────────────────────
router.post("/reveal-winner", async (req, res) => {
    try {
        const { randomnessPubkey } = req.body;

        const sbProgram = await getSbProgram(); // ✅ correct program ID

        const randomness = new sb.Randomness(
            sbProgram,
            new PublicKey(randomnessPubkey)
        );

        console.log("Waiting for randomness...");
        await new Promise(r => setTimeout(r, 5000));

        const revealIx = await retryReveal(randomness);
        const { roundPda } = await getCurrentRound();

        const revealProgramIx = await program.methods
            .revealWinner()
            .accounts({
                signer: keypair.publicKey,
                roundAccount: roundPda,
                randomnessAccountData: new PublicKey(randomnessPubkey),
            })
            .instruction();

        const revealTx = await sb.asV0Tx({
            connection,
            ixs: [revealIx, revealProgramIx],
            payer: keypair.publicKey,
            signers: [keypair],
            ...TX_OPTIONS,
        });

        const sig = await connection.sendTransaction(revealTx);
        await connection.confirmTransaction(sig, "confirmed");
        console.log("Winner revealed:", sig);

        res.json({ success: true, signature: sig });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/distribute_reward", async (req, res) => {
    try {
        const {
            globalPda,
            roundPda,
            roundIdBuffer,
            treasury,
            ticketPda,
            winnerBuffer
        } = await getCurrentRound();

        const ticketData = await program.account.ticket.fetchNullable(ticketPda);
        console.log("🎟 Ticket data:", ticketData);

        const globalState = await program.account.globalState.fetch(globalPda);
        console.log("📊 Global state:", {
            roundId: globalState.roundId.toString(),
            admin: globalState.admin.toBase58(),
        });

        let remainingAccounts = [];

        if (ticketData && ticketData.users.length > 0) {
            for (let i = 0; i < ticketData.users.length; i++) {
                const [userTicketPda] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("user_ticket"),
                        ticketData.users[i].toBuffer(),
                        roundIdBuffer,
                        winnerBuffer,
                    ],
                    program.programId
                );

                remainingAccounts.push(
                    {
                        pubkey: ticketData.users[i],
                        isWritable: true,
                        isSigner: false,
                    },
                    {
                        pubkey: userTicketPda,
                        isWritable: false,
                        isSigner: false,
                    }
                );
            }
        }

        const tx = await program.methods
            .distributeReward()
            .accounts({
                signer: keypair.publicKey,
                globalAccount: globalPda,
                roundAccount: roundPda,
                treasury: treasury,
                // ✅ ticket exist karta hai toh pass karo, nahi toh null
                ticketAccount: ticketData ? ticketPda : null,
                admin: globalState.admin,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .remainingAccounts(remainingAccounts) // ✅ uncomment karo
            .rpc();

        await connection.confirmTransaction(tx, "confirmed");
        console.log("✅ Reward distributed:", tx);

        res.json({
            success: true,
            tx,
            message: ticketData ? "Distributed to winners" : "No winners → sent to admin",
        });

    } catch (err) {
        console.error("❌ Distribute error:", err);
        res.status(500).json({ error: err.message });
    }
});

router.get("/ticket_data", async (req, res) => {
    try {
        const { globalPda, roundIdBuffer } = await getCurrentRound();

        const tickets = [];

        for (let i = 1; i <= 25; i++) {
            try {
                const [ticketPda] = PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("ticket"),
                        roundIdBuffer,
                        Buffer.from([i]), // u8 — 1 byte
                    ],
                    program.programId
                );

                const data = await program.account.ticket.fetchNullable(ticketPda);

                if (!data) {
                    tickets.push({
                        ticketNo: i,
                        exists: false,
                        totalAmount: "0",
                        users: [],
                    });
                } else {
                    // For each user on this ticket, fetch their UserTicket PDA
                    const usersWithAmount = await Promise.all(
                        data.users.map(async (userPubkey) => {
                            try {
                                const [userTicketPda] = PublicKey.findProgramAddressSync(
                                    [
                                        Buffer.from("user_ticket"),
                                        userPubkey.toBuffer(),
                                        roundIdBuffer,
                                        Buffer.from([i]),
                                    ],
                                    program.programId
                                );

                                const userTicket = await program.account.userTicket.fetchNullable(userTicketPda);

                                return {
                                    pubkey: userPubkey.toBase58(),
                                    amount: userTicket ? userTicket.amount.toString() : "0",
                                };
                            } catch {
                                return {
                                    pubkey: userPubkey.toBase58(),
                                    amount: "0",
                                };
                            }
                        })
                    );

                    tickets.push({
                        ticketNo: i,
                        exists: true,
                        totalAmount: data.totalAmount.toString(),
                        users: usersWithAmount,
                    });
                }
            } catch (err) {
                console.log(`Error fetching ticket ${i}:`, err.message);
                tickets.push({
                    ticketNo: i,
                    exists: false,
                    totalAmount: "0",
                    users: [],
                });
            }
        }

        res.json({ success: true, tickets });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// close round 

router.post("/close-round", async (req, res) => {
    try {
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

        const tx = await program.methods
            .closeAccount()
            .accounts({
                signer: keypair.publicKey,
                globalAccount: globalPda,
                roundAccount: roundPda,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        await connection.confirmTransaction(tx, "confirmed");

        console.log("Round Closed:", tx);

        res.json({ success: true, tx });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

export default router;

