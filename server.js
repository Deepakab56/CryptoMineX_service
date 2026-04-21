import express from "express";
import cors from "cors";
import lotteryRoutes from "./routes/lottery.js";
import "../beckend/scheduler/cron.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/lottery", lotteryRoutes);

app.get("/", (req, res) => {
  res.send("Lottery Backend Running 🚀");
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});