import cron from "node-cron";
import { createRound } from "../controller/createRound.js";
import { closeRound } from "../controller/closeRound.js";
import { commitrandomness } from "../controller/commitRandomness.js";
import { revealWinner } from "../controller/revealWinner.js";
import { distributeReward } from "../controller/distributeReward.js";
import { getCurrentRound } from "../routes/lottery.js";
import { program } from "../config/solana.js";

const ROUND_DURATION = 1 * 60 * 1000;


let localState = {
    isOpen: false,
    startTime: null,
    isCommitted: false,
    isRevealed: false,
    isDistributed: false,
    randomnessPubkey: null,
};

let isProcessing = false;

const handleRoundLifecycle = async () => {
    const now = Date.now();

    // 🟢 CREATE ROUND
    if (!localState.isOpen) {
        console.log("🟢 Opening new round...");
        await createRound();

        localState = {
            isOpen: true,
            startTime: now,
            isCommitted: false,
            isRevealed: false,
            isDistributed: false,
            randomnessPubkey: null,
        };

        console.log("✅ Round started");
        return;
    }

    const elapsed = now - localState.startTime;


    const { roundPda } = await getCurrentRound();
    const onChainRound = await program.account.round.fetch(roundPda); // ✅ onChainRound

    console.log("📊 On-chain users:", onChainRound.users.length);


    if (onChainRound.users.length > 0) {

        // ✅ COMMIT
        if (elapsed >= ROUND_DURATION && !localState.isCommitted) {
            console.log("🎲 Committing randomness...");

            const randomnessPubkey = await commitrandomness();

            if (!randomnessPubkey) {
                throw new Error("randomnessPubkey is undefined");
            }

            localState.isCommitted = true;          // ✅ local state update
            localState.randomnessPubkey = randomnessPubkey;

            console.log("✅ Randomness committed:", randomnessPubkey);
            return;
        }

        // ✅ REVEAL
        if (localState.isCommitted && !localState.isRevealed) {
            console.log("🏆 Revealing winner...");

            let success = false;
            let retries = 5;

            while (!success && retries > 0) {
                try {
                    await revealWinner(localState.randomnessPubkey); // ✅ localState
                    success = true;
                } catch (err) {
                    console.log("⏳ Waiting for VRF...", retries, "retries left");
                    await new Promise(r => setTimeout(r, 3000));
                    retries--;
                }
            }

            if (!success) throw new Error(" Reveal failed after retries");

            localState.isRevealed = true;           // ✅ local state update
            console.log("✅ Winner revealed");
            return;
        }

        // ✅ DISTRIBUTE
        if (localState.isRevealed && !localState.isDistributed) {
            console.log("💰 Distributing reward...");

            try {
                await distributeReward();

                localState.isDistributed = true;        // ✅ local state update
                console.log("✅ Reward distributed");
                return;
            } catch (error) {
                console.log(error)
            }
        }

        // ✅ CLOSE
        if (localState.isDistributed) {
            console.log("🔴 Closing round...");
            try {
                await closeRound();

                localState = {
                    isOpen: false,
                    startTime: null,
                    isCommitted: false,
                    isRevealed: false,
                    isDistributed: false,
                    randomnessPubkey: null,
                };

                console.log("✅ Round completed\n");
                return;
            } catch (error) {
                console.log(error)
            }
        }

    } else {

        if (elapsed >= ROUND_DURATION) {
            console.log("🔴 No users — closing round...");
            try {
                await closeRound();

                localState = {
                    isOpen: false,
                    startTime: null,
                    isCommitted: false,
                    isRevealed: false,
                    isDistributed: false,
                    randomnessPubkey: null,
                };

                console.log("✅ Empty round closed\n");
                return;
            } catch (error) {
                console.log(error)


            }
        }
    }


    const remaining = Math.max(0, ROUND_DURATION - elapsed);
    console.log(`⏳ Running... ${Math.floor(remaining / 1000)}s left`);
};

// ─────────────────────────────────────────────
// CRON — every 5 seconds
// ─────────────────────────────────────────────
cron.schedule("*/10 * * * * *", async () => {
    if (isProcessing) {
        console.log("⚠️ Previous execution still running...");
        return;
    }

    isProcessing = true;

    try {
        await handleRoundLifecycle();
    } catch (err) {
        console.error(" Scheduler error:", err.message);
    } finally {
        isProcessing = false;
    }
});