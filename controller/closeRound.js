
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";

import { connection, keypair, program } from "../config/solana.js";
import BN from "bn.js"

export const closeRound = async () => {
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

        // res.json({ success: true, tx });

    } catch (err) {
        console.error(err);

    }
}