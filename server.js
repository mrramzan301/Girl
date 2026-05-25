const express = require("express");
const { startBot, getPairingCode, isBotConnected } = require("./index.js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTML Web UI Panel
app.get("/", (req, res) => {
  const connected = isBotConnected();
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Zara Bot Web Panel</title>
        <style>
            body { font-family: Arial, sans-serif; background: #f4f7f6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; }
            h2 { color: #075e54; }
            input { width: 90%; padding: 12px; margin: 15px 0; border: 1px solid #ccc; border-radius: 5px; font-size: 16px; }
            button { background: #128c7e; color: white; border: none; padding: 12px 20px; border-radius: 5px; font-size: 16px; cursor: pointer; width: 95%; }
            button:hover { background: #075e54; }
            .code-box { background: #e1f5fe; padding: 15px; border-radius: 5px; font-size: 24px; font-weight: bold; letter-spacing: 3px; color: #0288d1; margin-top: 15px; border: 1px dashed #0288d1; }
            .status { margin-bottom: 10px; font-weight: bold; color: ${connected ? 'green' : 'red'}; }
        </style>
    </head>
    <body>
        <div class="card">
            <h2>Zara Bot Connection Panel</h2>
            <div class="status">Status: ${connected ? "✅ Connected & Online" : "❌ Disconnected"}</div>
            
            ${!connected ? `
                <form action="/submit-number" method="POST">
                    <p>Apna WhatsApp Number likhein (With Country Code, e.g., 923097508053)</p>
                    <input type="text" name="phoneNumber" placeholder="923XXXXXXXXX" required />
                    <button type="submit">Get Pairing Code</button>
                </form>
            ` : `<p style="color: green;">Bot successfully chal raha hai! Ab aap panel band kar sakte hain.</p>`}

            <div id="pairing-section"></div>
        </div>
    </body>
    </html>
  `);
});

// Submit Number Route
app.post("/submit-number", async (req, res) => {
  const num = req.body.phoneNumber.replace(/[^0-9]/g, "");
  
  if (!num) {
    return res.send("Invalid Number! <a href='/'>Go Back</a>");
  }

  // Bot start karein background mein
  startBot(num);

  // Code generate hone ka thora wait karein
  setTimeout(async () => {
    const code = getPairingCode();
    if (code) {
      res.send(`
        <html lang="en">
        <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Pairing Code</title><style>body { font-family: Arial; text-align: center; background: #f4f7f6; padding-top: 50px; } .box { background: white; display: inline-block; padding: 30px; border-radius: 10px; box-shadow: 0 4px 10px rgba(0,0,0,0.1); } .code { font-size: 32px; font-weight: bold; color: #0288d1; background: #e1f5fe; padding: 10px 20px; border-radius: 5px; margin: 20px 0; letter-spacing: 4px; }</style></head>
        <body>
            <div class="box">
                <h2>Aapka Pairing Code</h2>
                <div class="code">${code}</div>
                <p>Apne WhatsApp -> Linked Devices -> Link with phone number par ja kar ye code enter karein.</p>
                <br><a href="/">Check Status</a>
            </div>
        </body>
        </html>
      `);
    } else {
      res.send("⏳ Code generate ho raha hai, page ko 5 seconds baad refresh karein. <a href='/submit-number' onclick='event.preventDefault(); location.reload();'>Refresh</a>");
    }
  }, 6000);
});

app.listen(PORT, () => {
  console.log(`Web panel server running on port ${PORT}`);
});
