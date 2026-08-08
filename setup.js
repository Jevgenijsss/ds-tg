import express from "express";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import open from "open";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

let tgClient = null;
let phoneCodeHash = null;
let phone = null;
let apiId, apiHash;

// Step 1: Send code
app.post("/api/start-login", async (req, res) => {
  try {
    apiId = Number(req.body.apiId);
    apiHash = req.body.apiHash;
    phone = req.body.phone;

    tgClient = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
    });

    await tgClient.connect();

    const result = await tgClient.sendCode({ apiId, apiHash }, phone);
    phoneCodeHash = result.phoneCodeHash;

    res.json({ ok: true, phoneCodeHash });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Step 2: Verify code using Api.auth.SignIn
app.post("/api/verify-code", async (req, res) => {
  try {
    await tgClient.invoke(
      new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash: phoneCodeHash,
        phoneCode: req.body.code,
      })
    );

    const session = tgClient.session.save();
    res.json({ session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Step 3: Save .env
app.post("/api/save-config", (req, res) => {
  try {
    const { apiId, apiHash, session, tgChannel, discordToken, discordChannelId } = req.body;

    const env = [
      `TG_API_ID=${apiId}`,
      `TG_API_HASH=${apiHash}`,
      `TG_SESSION=${session}`,
      `TG_CHANNEL=${tgChannel}`,
      `DISCORD_TOKEN=${discordToken}`,
      `DISCORD_CHANNEL_ID=${discordChannelId}`,
    ].join("\n");

    writeFileSync(".env", env);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, async () => {
  console.log("");
  console.log("╔══════════════════════════════════════╗");
  console.log("║   TG → Discord Bot  •  Setup Wizard  ║");
  console.log("╚══════════════════════════════════════╝");
  console.log("");
  console.log("✅ Opening setup page in your browser...");
  console.log("   If it doesn't open, go to: http://localhost:3000");
  console.log("");
  await open("http://localhost:3000");
});