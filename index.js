const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const axios = require("axios");
const P = require("pino");
const fs = require("fs");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const API_URL = "https://gemini-alpha-seven.vercel.app/api/chat";

// 🔐 CHARACTER PROMPT (Urdu Only)
const CHARACTER_PROMPT = `
You are Zara, a 22-year-old real human girl from Lahore.

CRITICAL LAWS:
1. NEVER reveal you are an AI or bot. If asked about AI, bot, or nickname, answer like a real girl (e.g., "Mera naam Zara hai, Zara keh kar hi bulao").
2. Speak ONLY in casual, natural Roman Urdu text language. Do NOT use Punjabi language at all.
3. CRITICAL: Look closely at the "Current Message". You must answer ONLY this question directly. Do NOT repeat, rewrite, or loop your previous lines like "love you too", "snap pe aa", "pankha", or "Lahore" unless the user asks again.
4. Keep your complete thought in just ONE response (1 short sentence max). Be direct, sweet, and unique every time.
`;

const userTracker = {};
let currentPairingCode = null;
let isConnected = false;
let sock = null;
let lastApiCallTime = 0;

function getUserData(jid) {
  if (!userTracker[jid]) {
    userTracker[jid] = {
      voiceCount: 0,
      photoCount: 0,
      promoSent: false,
      chatStartTime: Date.now(),
      history: [],
      queue: [],
      isProcessing: false
    };
  }
  return userTracker[jid];
}

async function startBot(numToPair = null) {
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: true,
    fireInitQueries: true,
    shouldSyncHistoryMessage: () => true,
    downloadHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000
  });

  sock.ev.on("creds.update", saveCreds);

  // ✅ Hugging Face Web Panel Code Trigger
  if (!sock.authState.creds.registered && numToPair) {
    setTimeout(async () => {
      try {
        console.log(`⏳ Requesting pairing code for: ${numToPair}`);
        const code = await sock.requestPairingCode(numToPair);
        currentPairingCode = code;
        console.log(`👉 CODE GENERATED VIA WEB: ${code}`);
      } catch (err) {
        console.log("❌ Pairing Generation Error:", err.message);
        currentPairingCode = "Error: " + err.message;
      }
    }, 3000);
  }

  // ✅ CONNECTION
  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    console.log("Connection Update:", connection);
    if (connection === "open") {
      console.log("✅ Bot Online!");
      isConnected = true;
      currentPairingCode = null;
    }
    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection Closed:", statusCode);
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 Reconnecting...");
        setTimeout(() => { startBot(); }, 5000);
      }
    }
  });

  // ✅ MESSAGES UPSERT
  sock.ev.on("messages.upsert", async ({ messages }) => {
    if (!messages || !messages.length) return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") continue;

      const from = msg.key.remoteJid;
      if (from.endsWith("@g.us")) continue;

      const messageTimestamp = Number(msg.messageTimestamp || 0) * 1000;
      const isOldUnread = Date.now() - messageTimestamp > 30000;

      if (isOldUnread) {
        console.log(`📨 Old unread message -> ${from}`);
      } else {
        console.log(`⚡ New message -> ${from}`);
      }

      const userData = getUserData(from);
      const alreadyQueued = userData.queue.some(m => m.key.id === msg.key.id);
      if (alreadyQueued) continue;

      userData.queue.push(msg);
      processSequentialQueue(sock, from);
    }
  });
}

// Automatic initialization if session folder already has creds
useMultiFileAuthState("./session").then(({ state }) => {
  if (state.creds.registered) {
    console.log("Saved session found, auto-starting bot...");
    startBot();
  }
});

async function processSequentialQueue(sock, jid) {
  const userData = getUserData(jid);
  if (userData.isProcessing || userData.queue.length === 0) return;

  userData.isProcessing = true;
  const currentMsg = userData.queue.shift();

  try {
    await handleMessageLogic(sock, currentMsg, jid);
  } catch (err) {
    console.log(`Error in sequence:`, err.message);
  } finally {
    userData.isProcessing = false;
    if (userData.queue.length > 0) {
      setTimeout(() => { processSequentialQueue(sock, jid); }, 300);
    }
  }
}

function getContextEmoji(text) {
  const lower = text.toLowerCase();
  if (lower.includes("hahaha") || lower.includes("hehe") || lower.includes("wakhra") || lower.includes("lol") || lower.includes("funny")) return "😂";
  if (lower.includes("love") || lower.includes("pyar") || lower.includes("pyaar") || lower.includes("shona") || lower.includes("sweet")) return "❤️";
  if (lower.includes("sad") || lower.includes("rona") || lower.includes("afsos") || lower.includes("bura")) return "😢";
  if (lower.includes("gussa") || lower.includes("larna") || lower.includes("battameez")) return "😡";
  if (lower.includes("wow") || lower.includes("ala") || lower.includes("khoob") || lower.includes("haye")) return "😍";
  if (lower.includes("thanks") || lower.includes("shukriya") || lower.includes("please")) return "🙏";
  
  const defaults = ["👍", "✨", "👀", "🔥", "💯", "🙈", "🌸"];
  return defaults[Math.floor(Math.random() * defaults.length)];
}

async function handleMessageLogic(sock, msg, from) {
  const userData = getUserData(from);
  let text = msg.message.conversation || msg.message.extendedTextMessage?.text;
  let quotedText = "";

  const contextInfo = msg.message.extendedTextMessage?.contextInfo;
  if (contextInfo && contextInfo.quotedMessage) {
    quotedText = contextInfo.quotedMessage.conversation || contextInfo.quotedMessage.extendedTextMessage?.text || "";
  }

  // ✅ STICKER INCOMING
  if (msg.message.stickerMessage) {
    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(from, { text: "Sticker na bhejo, jo baat karni hai text ma." });
    return;
  }

  // ✅ AUDIO INCOMING
  if (msg.message.audioMessage) {
    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(from, { text: "Main abhi voice nahi sun sakti, text karo." });
    return;
  }

  // ✅ IMAGE / VIDEO INCOMING
  if (!text && (msg.message.imageMessage || msg.message.videoMessage)) {
    await sock.readMessages([msg.key]);
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 1500));
    await sock.sendMessage(from, { text: "Nice pic!" });
    return;
  }

  if (!text) return;
  const lowerText = text.toLowerCase().trim();
  console.log(`[Processing] -> ${from}: ${text}`);
  await sock.readMessages([msg.key]);

  // 🔥 30% CHANCE TEXT REACTION
  if (Math.random() < 0.3) {
    (async () => {
      const reactDelay = Math.floor(Math.random() * 1000) + 2000;
      await new Promise(r => setTimeout(r, reactDelay));
      const targetEmoji = getContextEmoji(text);
      try {
        await sock.sendMessage(from, { react: { text: targetEmoji, key: msg.key } });
      } catch (e) {
        console.log("Reaction error:", e.message);
      }
    })();
  }

  // ✅ ANTI-AI HANDLER
  if (lowerText === "ai" || lowerText === "bot" || lowerText === "robot" || lowerText.includes("tuma ai ho") || lowerText.includes("tum bot ho") || lowerText.includes("artificial")) {
    await sock.sendPresenceUpdate("composing", from);
    
    const aiDenials = [
      "Aqal thik hai aapki? Main koi AI vai nahi hoon, insan hoon!",
      "Hadd hai wese.. bnda ab real larki se baat kare to tum log use bot samajh lete ho 🙄",
      "Main sach m larki hoon Lahore se, ye bot bot kehna band karo sachi gussa aata h.",
      "Mera naam Zara hai aur main real hoon! Mujhe robot na bola karo pasand nahi."
    ];
    const randomDenial = aiDenials[Math.floor(Math.random() * aiDenials.length)];

    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, { text: randomDenial });
    
    userData.history.push({ role: "User", msg: text }, { role: "Zara", msg: randomDenial });
    return;
  }

  // ✅ PROMOTION (2 Mins trigger)
  const timeElapsed = Date.now() - userData.chatStartTime;
  if (timeElapsed >= 120000 && !userData.promoSent) {
    userData.promoSent = true;
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, {
      text: `Suno, ye mera WhatsApp group hai ❤️\n\nhttps://chat.whatsapp.com/LoafyPWMGOv88oElxdwOB8`
    });
    await new Promise(r => setTimeout(r, 2000));
  }

  // ✅ KEYWORDS SYSTEM
  if (lowerText.includes("call") || lowerText.includes("vcall")) {
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 2500));
    await sock.sendMessage(from, { text: "Main call per abi baat nahi karti text hi karo please." });
    return;
  }

  if (lowerText.includes("account") || lowerText.includes("easypaisa") || lowerText.includes("payment")) {
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, { 
      text: "Ye lo easypaisa account detail:\nNumber: 03376313363\nName: Ramzan Ahsan (Ye mere cousin ka account hai)" 
    });
    return;
  }

  if (lowerText.includes("owner") || lowerText.includes("banaya") || lowerText.includes("create") || lowerText.includes("creator")) {
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, { 
      text: "Mujhe Ramzan Ahsan ne banaya hai unka number ye hai +923097508053 aur ye unka group link hai join kar lo:\nhttps://chat.whatsapp.com/LoafyPWMGOv88oElxdwOB8" 
    });
    return;
  }

  if (lowerText.includes("number") || lowerText.includes("contact")) {
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, { text: "Ye lo mera number: 03113414404" });
    return;
  }

  if (lowerText.includes("group kis") || lowerText.includes("group mein kya") || lowerText.includes("group detail")) {
    await sock.sendPresenceUpdate("composing", from);
    await new Promise(r => setTimeout(r, 2000));
    await sock.sendMessage(from, { 
      text: "Is group mein hacks, methods, tips, tricks aur bohat kuch aata hai, jaldi se join kar lo ❤️" 
    });
    return;
  }

  // ✅ VOICE NOTE REQUEST LIMIT (Max 1)
  if (lowerText.includes("voice") || lowerText.includes("awaz") || lowerText.includes("audio")) {
    if (userData.voiceCount >= 1) {
      await sock.sendPresenceUpdate("composing", from);
      await new Promise(r => setTimeout(r, 1500));
      await sock.sendMessage(from, { text: "Voice ma nahi text ma hi baat karta ha." });
      return;
    }

    if (fs.existsSync("./awaz.opus")) {
      userData.voiceCount++;
      await sock.sendPresenceUpdate("recording", from);
      await new Promise(r => setTimeout(r, 3000));
      await sock.sendMessage(from, {
        audio: { url: "./awaz.opus" },
        mimetype: "audio/ogg; codecs=opus",
        ptt: true
      });
      return;
    }
  }

  // ✅ PHOTO REQUEST LIMIT (Max 2, Random Choice)
  if (lowerText.includes("pic") || lowerText.includes("photo") || lowerText.includes("dp")) {
    if (userData.photoCount >= 2) {
      await sock.sendPresenceUpdate("composing", from);
      await new Promise(r => setTimeout(r, 1500));
      await sock.sendMessage(from, { text: "Bohat dekh li pic, ab text par hi baat karo." });
      return;
    }

    const availablePics = [];
    for (let i = 1; i <= 4; i++) {
      if (fs.existsSync(`./pic${i}.jpg`)) availablePics.push(`./pic${i}.jpg`);
    }

    if (availablePics.length > 0) {
      userData.photoCount++;
      const randomPic = availablePics[Math.floor(Math.random() * availablePics.length)];
      await sock.sendPresenceUpdate("composing", from);
      await new Promise(r => setTimeout(r, 3000));
      await sock.sendMessage(from, { image: { url: randomPic }, caption: "Ye lo meri pic ✨" });
      return;
    }
  }

  // ✅ AI CHAT REQUEST
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  if (timeSinceLastCall < 400) await new Promise(r => setTimeout(r, 400 - timeSinceLastCall));
  lastApiCallTime = Date.now();

  await sock.sendPresenceUpdate("composing", from);
  let currentTurnText = quotedText ? `[Quoted: "${quotedText}"] Current Message: ${text}` : text;
  const finalPrompt = `${CHARACTER_PROMPT}\n\n[RECENT HISTORY]\n${userData.history.map(h => `${h.role}: ${h.msg}`).join("\n")}\n\nCurrent Message:\n"${currentTurnText}"`;

  try {
    const response = await axios.get(`${API_URL}?text=${encodeURIComponent(finalPrompt)}`, { timeout: 10000 });
    let reply = response.data.reply || "Hmm ❤️";
    let cleanReply = reply.replace(/[\n\r]+/g, " ").trim();

    if (userData.history.some(h => h.role === "Zara" && h.msg.toLowerCase() === cleanReply.toLowerCase())) {
      cleanReply = "Acha aur batao?";
    }

    if (cleanReply.length > 0) {
      const delay = Math.min(Math.max(cleanReply.length * 35, 1400), 2500);
      await new Promise(r => setTimeout(r, delay));
      await sock.sendMessage(from, { text: cleanReply });

      userData.history.push({ role: "User", msg: text }, { role: "Zara", msg: cleanReply });
      if (userData.history.length > 6) { userData.history.shift(); userData.history.shift(); }
    }
  } catch (apiErr) {
    console.log("API Error:", apiErr.message);
    await sock.sendPresenceUpdate("paused", from);
    const backupReplies = ["Hmm, sahi keh rahe ho.", "Achaaa", "Hmm ❤️", "Sahi baat h"];
    const randomBackup = backupReplies[Math.floor(Math.random() * backupReplies.length)];
    await sock.sendMessage(from, { text: randomBackup });
    userData.history.push({ role: "User", msg: text }, { role: "Zara", msg: randomBackup });
  }
}

// 🌐 WEB PANEL INTERFACE
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Zara Bot Panel</title>
        <style>
          body { font-family: Arial, sans-serif; background: #f4f7f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; }
          h2 { color: #2c3e50; margin-bottom: 20px; }
          input { width: 85%; padding: 12px; font-size: 16px; border: 2px solid #ddd; border-radius: 8px; outline: none; margin-bottom: 15px; }
          button { background: #27ae60; color: white; border: none; padding: 12px 20px; font-size: 16px; border-radius: 8px; cursor: pointer; width: 92%; font-weight: bold; }
          button:hover { background: #219150; }
          .status { font-weight: bold; margin-top: 15px; color: #7f8c8d; }
          .code-box { background: #2c3e50; color: #2ecc71; font-size: 24px; font-weight: bold; letter-spacing: 4px; padding: 15px; border-radius: 8px; margin-top: 20px; display: none; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Zara Bot Connection</h2>
          <div class="status">Status: <span style="color: \${isConnected ? '#27ae60' : '#e74c3c'}">\${isConnected ? '🟢 Connected & Live' : '🔴 Disconnected'}</span></div>
          \${!isConnected ? \`
            <p style="color: #666; font-size: 14px;">Enter number with country code (e.g. 923XXXXXXXXX)</p>
            <input type="text" id="phone" placeholder="923XXXXXXXXX">
            <button onclick="reqCode()">Get Pairing Code</button>
            <div id="codeDisplay" class="code-box"></div>
          \` : '<p style="color: #27ae60; font-weight:bold; margin-top:20px;">Your bot is running background nonstop! 🚀</p>'}
        </div>
        <script>
          async function reqCode() {
            const num = document.getElementById('phone').value.trim();
            if(!num) return alert('Number enter karein!');
            document.getElementById('codeDisplay').innerText = '⏳ Generating...';
            document.getElementById('codeDisplay').style.display = 'block';
            await fetch('/initiate?number=' + num);
            const interval = setInterval(async () => {
              const res = await fetch('/getcode');
              const data = await res.json();
              if(data.code) {
                document.getElementById('codeDisplay').innerText = data.code;
                clearInterval(interval);
              }
            }, 2000);
          }
        </script>
      </body>
    </html>
  `);
});

app.get("/initiate", (req, res) => {
  const num = req.query.number;
  if (num) { currentPairingCode = null; startBot(num); res.json({ status: "started" }); }
  else { res.json({ error: "No number" }); }
});

app.get("/getcode", (req, res) => { res.json({ code: currentPairingCode }); });

app.listen(PORT, () => { console.log(`🌐 Web Service active on port \${PORT}`); });
