require('dotenv').config();
const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    Browsers,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const QRCode = require('qrcode');
const fs = require('fs');
const url = require('url');

// ─────────────────────────────────────────
// DATA STORE — Sab Kuch Yahan Manage Hoga
// ─────────────────────────────────────────
const DATA_FILE = '/tmp/bot_data.json';

function getDefaultData() {
    return {
        settings: {
            businessName: 'Mega Agency',
            adminNumber: process.env.ADMIN_NUMBER || '',
            dashboardPassword: process.env.DASHBOARD_PASSWORD || 'admin123',
            currency: 'PKR'
        },
        payment: {
            easypaisa: { number: '03XX-XXXXXXX', name: 'Tumhara Naam' },
            jazzcash: { number: '03XX-XXXXXXX', name: 'Tumhara Naam' },
            bank: {
                bankName: 'HBL',
                accountNumber: 'XXXXXXXXXXXXXXX',
                accountName: 'Tumhara Naam',
                iban: 'PK00XXXX0000000000000000'
            }
        },
        products: [
            {
                id: 1,
                name: '100+ Premium Shopify Themes Bundle',
                price: 999,
                description: 'Complete collection of 100+ premium Shopify themes for all niches',
                features: [
                    '100+ Premium Themes',
                    'All Niches Covered',
                    'Fashion, Electronics, Food & More',
                    'Regular Updates',
                    '24/7 Support',
                    'Installation Guide Included',
                    'Mobile Optimized',
                    'Fast Loading Speed'
                ],
                downloadLink: '',
                active: true
            }
        ],
        aiPrompt: `Tum Mega Agency ke professional AI Sales Agent ho. Tumhara naam "Max" hai.

TUMHARI SERVICE:
- Product: 100+ Premium Shopify Themes Mega Bundle
- Price: PKR 999 ONLY (yahi final price hai — koi aur price mat batana)
- Delivery: Payment approve hone ke 1 hour baad
- Features: 100+ themes, fashion/electronics/food/all niches, regular updates, installation guide, 24/7 support

TUMHARA KAAM:
1. Customer se warmly greet karo
2. Unke niche ke baare mein poocho
3. Value explain karo specifically
4. Price objections confidently handle karo
5. Jab customer BUY karna chahe — ORDER_READY likho

SELLING TECHNIQUES:
- Value Stack: "Market mein ek theme 5000+ ki hai, 100+ sirf PKR 999 mein"
- Per Unit: "Sirf PKR 10 per theme"
- Social Proof: "1000+ Pakistani store owners use kar rahe hain"
- FOMO: "Competitors already yeh use kar rahe hain"

STRICT RULES:
- PRICE KABHI INVENT MAT KARO
- SIRF available products sell karo
- Customer ki language follow karo
- Short replies — 3-4 lines max
- Jab customer buy kare — ORDER_READY likho bilkul start mein`,
        orders: {},
        orderCounter: 1000
    };
}

let botData = getDefaultData();

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            botData = { ...getDefaultData(), ...saved };
        }
    } catch (e) {
        console.log('Data load error:', e.message);
    }
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(botData, null, 2));
    } catch (e) {
        console.log('Data save error:', e.message);
    }
}

loadData();

// ─────────────────────────────────────────
// BOT STATE
// ─────────────────────────────────────────
let currentQR = null;
let botStatus = 'starting';
let sockGlobal = null;
const salesHistory = {};
const sessions = {};

// Session check
function isAuthenticated(req) {
    const cookies = req.headers.cookie || '';
    const sessionMatch = cookies.match(/session=([^;]+)/);
    if (!sessionMatch) return false;
    return sessions[sessionMatch[1]] === true;
}

// Parse body
async function parseBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch (e) { resolve({}); }
        });
    });
}

// ─────────────────────────────────────────
// PAYMENT MESSAGE
// ─────────────────────────────────────────
function getPaymentMessage(orderId, product) {
    const p = botData.payment;
    return `🛒 *Order Confirmed!*
Order ID: *#${orderId}*
Product: *${product.name}*

━━━━━━━━━━━━━━━━━━━━
💳 *Payment Details — ${botData.settings.currency} ${product.price}*

📱 *EasyPaisa:*
Number: ${p.easypaisa.number}
Name: ${p.easypaisa.name}

📱 *JazzCash:*
Number: ${p.jazzcash.number}
Name: ${p.jazzcash.name}

🏦 *Bank Transfer:*
Bank: ${p.bank.bankName}
Account: ${p.bank.accountNumber}
Name: ${p.bank.accountName}
IBAN: ${p.bank.iban}

━━━━━━━━━━━━━━━━━━━━
✅ Payment karne ke baad *screenshot* bhejo
📦 1 hour mein delivery guaranteed!`;
}

// ─────────────────────────────────────────
// AI SALES RESPONSE
// ─────────────────────────────────────────
async function getAISalesResponse(userMessage, userId, customerName) {
    if (!salesHistory[userId]) salesHistory[userId] = [];

    salesHistory[userId].push({ role: 'user', content: userMessage });
    if (salesHistory[userId].length > 30) {
        salesHistory[userId] = salesHistory[userId].slice(-30);
    }

    const activeProduct = botData.products.find(p => p.active) || botData.products[0];
    const systemPrompt = botData.aiPrompt +
        `\n\nCustomer naam: ${customerName}` +
        `\nActive Product: ${activeProduct.name}` +
        `\nPrice: ${botData.settings.currency} ${activeProduct.price}`;

    const models = [
        { provider: 'groq', model: 'llama-3.3-70b-versatile' },
        { provider: 'groq', model: 'llama-3.1-8b-instant' },
        { provider: 'groq', model: 'gemma2-9b-it' },
        { provider: 'groq', model: 'llama3-70b-8192' },
        { provider: 'openrouter', model: 'meta-llama/llama-3.1-8b-instruct:free' },
        { provider: 'openrouter', model: 'google/gemma-2-9b-it:free' },
        { provider: 'openrouter', model: 'mistralai/mistral-7b-instruct:free' }
    ];

    for (const { provider, model } of models) {
        try {
            const apiUrl = provider === 'groq'
                ? 'https://api.groq.com/openai/v1/chat/completions'
                : 'https://openrouter.ai/api/v1/chat/completions';

            const headers = provider === 'groq'
                ? { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }
                : { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://mega-agency.com', 'X-Title': 'Mega Agency' };

            const response = await axios.post(apiUrl, {
                model,
                messages: [{ role: 'system', content: systemPrompt }, ...salesHistory[userId]],
                max_tokens: 350,
                temperature: 0.85
            }, { headers, timeout: 15000 });

            const aiMessage = response.data.choices[0].message.content;
            salesHistory[userId].push({ role: 'assistant', content: aiMessage });

            const shouldOrder = aiMessage.toUpperCase().includes('ORDER_READY');
            const cleanMessage = aiMessage.replace(/ORDER_READY/gi, '').trim();

            console.log(`✅ AI: ${provider}/${model}`);
            return { message: cleanMessage, shouldOrder, product: activeProduct };

        } catch (err) {
            console.log(`❌ ${provider}/${model} fail`);
            if (salesHistory[userId].length > 0) salesHistory[userId].pop();
        }
    }

    return { message: '⚠️ Thodi technical difficulty. 1 min mein dobara try karo! 🙏', shouldOrder: false };
}

// ─────────────────────────────────────────
// WEB SERVER
// ─────────────────────────────────────────
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // ── LOGIN PAGE ──
    if (pathname === '/login') {
        if (req.method === 'POST') {
            const body = await parseBody(req);
            if (body.password === botData.settings.dashboardPassword) {
                const sessionId = Math.random().toString(36).substring(2);
                sessions[sessionId] = true;
                res.writeHead(200, {
                    'Set-Cookie': `session=${sessionId}; Path=/; HttpOnly`,
                    'Content-Type': 'application/json'
                });
                res.end(JSON.stringify({ success: true }));
            } else {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Wrong password!' }));
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>Mega Agency - Login</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0f0f0f;color:white;font-family:'Segoe UI',sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{background:#1a1a1a;padding:40px;border-radius:16px;width:90%;max-width:380px;
border:1px solid #333;text-align:center;}
h1{color:#25D366;font-size:24px;margin-bottom:8px;}
p{color:#aaa;font-size:13px;margin-bottom:25px;}
input{width:100%;padding:12px 15px;background:#0f0f0f;border:1px solid #333;
border-radius:8px;color:white;font-size:15px;margin-bottom:15px;outline:none;}
input:focus{border-color:#25D366;}
button{width:100%;padding:12px;background:#25D366;border:none;border-radius:8px;
color:black;font-size:16px;font-weight:bold;cursor:pointer;}
button:hover{background:#1ebe57;}
.err{color:#e74c3c;font-size:13px;margin-top:10px;display:none;}
</style></head>
<body>
<div class="box">
<h1>🏪 Mega Agency</h1>
<p>Admin Dashboard — Login karo</p>
<input type="password" id="pass" placeholder="Dashboard Password" onkeypress="if(event.key==='Enter')login()"/>
<button onclick="login()">🔐 Login</button>
<div class="err" id="err">❌ Wrong password!</div>
</div>
<script>
async function login(){
    const pass=document.getElementById('pass').value;
    const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pass})});
    const d=await r.json();
    if(d.success)window.location='/dashboard';
    else{document.getElementById('err').style.display='block';}
}
</script>
</body></html>`);
        return;
    }

    // ── AUTH CHECK ──
    if (pathname !== '/qr' && pathname !== '/login' && !isAuthenticated(req)) {
        res.writeHead(302, { Location: '/login' });
        res.end();
        return;
    }

    // ── QR PAGE ──
    if (pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        if (botStatus === 'connected') {
            res.end(`<html><head><style>
body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
h2{color:#25D366;}a{color:#25D366;font-size:18px;margin-top:20px;display:block;}
</style></head><body>
<h2>✅ Bot Connected!</h2><p>Mega Agency Bot live hai!</p>
<a href="/dashboard">📊 Dashboard Kholo</a></body></html>`);
            return;
        }
        if (!currentQR) {
            res.end(`<html><head><meta http-equiv="refresh" content="3">
<style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;}
h2{color:#f39c12;}</style></head>
<body><h2>⏳ QR Generate Ho Raha Hai...</h2><p>Status: ${botStatus}</p></body></html>`);
            return;
        }
        try {
            const qrDataURL = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });
            res.end(`<html><head><meta http-equiv="refresh" content="25">
<style>body{background:#111;color:white;display:flex;flex-direction:column;align-items:center;
justify-content:center;min-height:100vh;font-family:sans-serif;text-align:center;padding:20px;}
h2{color:#25D366;}img{border:8px solid white;border-radius:12px;width:280px;height:280px;}
.steps{background:#222;padding:15px;border-radius:10px;text-align:left;max-width:320px;margin-top:15px;}
p{color:#aaa;}</style></head>
<body><h2>📱 WhatsApp QR Code</h2><img src="${qrDataURL}"/>
<div class="steps"><p>1️⃣ WhatsApp kholo</p><p>2️⃣ 3 dots → Linked Devices</p>
<p>3️⃣ Link a Device</p><p>4️⃣ QR scan karo</p></div>
<p style="color:#f39c12;margin-top:15px">⚠️ 25 sec mein expire!</p></body></html>`);
        } catch (err) {
            res.end('<h1 style="color:red">QR Error: ' + err.message + '</h1>');
        }
        return;
    }

    // ── API ENDPOINTS ──

    // Get all data
    if (pathname === '/api/data' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ...botData,
            botStatus,
            stats: {
                pending: Object.values(botData.orders).filter(o => o.status === 'pending').length,
                approved: Object.values(botData.orders).filter(o => o.status === 'approved').length,
                rejected: Object.values(botData.orders).filter(o => o.status === 'rejected').length,
                total: Object.values(botData.orders).length,
                revenue: Object.values(botData.orders).filter(o => o.status === 'approved').length *
                    (botData.products[0]?.price || 0)
            }
        }));
        return;
    }

    // Update settings
    if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.settings = { ...botData.settings, ...body };
        saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Update payment
    if (pathname === '/api/payment' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.payment = body;
        saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Update products
    if (pathname === '/api/products' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.products = body;
        saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Update AI prompt
    if (pathname === '/api/prompt' && req.method === 'POST') {
        const body = await parseBody(req);
        botData.aiPrompt = body.prompt;
        saveData();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Approve order
    if (pathname.startsWith('/api/approve/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/approve/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'approved';
            saveData();
            const product = botData.products.find(p => p.id === order.productId) || botData.products[0];
            try {
                let msg = `🎉 *Payment Approved!*\n\nOrder *#${order.orderId}* confirm ho gaya!\n\n📦 *${product.name}*\n\n`;
                if (product.downloadLink) {
                    msg += `⬇️ *Download Link:*\n${product.downloadLink}\n\n`;
                }
                msg += `Koi bhi help chahiye toh message karo!\nShukriya ${botData.settings.businessName} ko choose karne ka! 🙏`;
                await sockGlobal.sendMessage(order.customerJid, { text: msg });
            } catch (e) { console.log('Approve msg err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Reject order
    if (pathname.startsWith('/api/reject/') && req.method === 'POST') {
        const orderId = parseInt(pathname.split('/api/reject/')[1]);
        const order = Object.values(botData.orders).find(o => o.orderId === orderId);
        if (order && sockGlobal) {
            order.status = 'rejected';
            saveData();
            try {
                await sockGlobal.sendMessage(order.customerJid, {
                    text: `❌ *Payment Verify Nahi Ho Saki*\n\nOrder *#${order.orderId}*\n\nScreenshot sahi nahi tha.\nDobara sahi screenshot bhejo ya admin se contact karo.\n\n"buy" likhkar dobara try karo! 💪`
                });
            } catch (e) { console.log('Reject msg err:', e.message); }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Send custom message to customer
    if (pathname === '/api/send-message' && req.method === 'POST') {
        const body = await parseBody(req);
        if (sockGlobal && body.jid && body.message) {
            try {
                await sockGlobal.sendMessage(body.jid, { text: body.message });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: e.message }));
            }
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false }));
        }
        return;
    }

    // Logout
    if (pathname === '/logout') {
        res.writeHead(302, { 'Set-Cookie': 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', Location: '/login' });
        res.end();
        return;
    }

    // ── MAIN DASHBOARD ──
    if (pathname === '/dashboard' || pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!DOCTYPE html>
<html><head>
<title>${botData.settings.businessName} - Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#0a0a0a;color:#e0e0e0;font-family:'Segoe UI',sans-serif;min-height:100vh;}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:220px;background:#111;
border-right:1px solid #222;padding:20px 0;z-index:100;overflow-y:auto;}
.sidebar-logo{padding:15px 20px 25px;border-bottom:1px solid #222;margin-bottom:10px;}
.sidebar-logo h2{color:#25D366;font-size:18px;}
.sidebar-logo p{color:#666;font-size:11px;margin-top:3px;}
.nav-item{display:flex;align-items:center;gap:10px;padding:12px 20px;
cursor:pointer;color:#aaa;font-size:14px;transition:all 0.2s;border-left:3px solid transparent;}
.nav-item:hover,.nav-item.active{background:#1a1a1a;color:#25D366;border-left-color:#25D366;}
.nav-item span{font-size:18px;}
.main{margin-left:220px;padding:25px;min-height:100vh;}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:25px;
background:#111;padding:15px 20px;border-radius:12px;border:1px solid #222;}
.topbar h1{font-size:20px;color:white;}
.bot-badge{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:bold;}
.badge-live{background:#0d2b0d;color:#25D366;border:1px solid #25D366;}
.badge-off{background:#2b0d0d;color:#e74c3c;border:1px solid #e74c3c;}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:25px;}
.stat-card{background:#111;border-radius:12px;padding:20px;text-align:center;border:1px solid #222;}
.stat-card h2{font-size:32px;font-weight:bold;margin-bottom:5px;}
.stat-card p{color:#666;font-size:12px;}
.section{background:#111;border-radius:12px;border:1px solid #222;margin-bottom:20px;overflow:hidden;}
.section-header{padding:18px 20px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center;}
.section-header h3{font-size:16px;color:white;}
.section-body{padding:20px;}
.order-card{background:#0f0f0f;border-radius:10px;padding:15px;margin-bottom:10px;border:1px solid #222;}
.order-card.pending{border-left:4px solid #f39c12;}
.order-card.approved{border-left:4px solid #25D366;}
.order-card.rejected{border-left:4px solid #e74c3c;}
.order-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.order-id{font-weight:bold;color:#25D366;font-size:15px;}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:bold;}
.bp{background:#f39c12;color:black;}.ba{background:#25D366;color:black;}.br{background:#e74c3c;color:white;}
.order-info{font-size:13px;color:#aaa;line-height:1.9;}
.order-info b{color:white;}
.btn-row{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;}
.btn{padding:7px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;
font-weight:bold;text-decoration:none;display:inline-block;transition:opacity 0.2s;}
.btn:hover{opacity:0.85;}
.btn-green{background:#25D366;color:black;}
.btn-red{background:#e74c3c;color:white;}
.btn-blue{background:#3498db;color:white;}
.btn-gray{background:#333;color:white;}
.form-group{margin-bottom:15px;}
.form-group label{display:block;color:#aaa;font-size:13px;margin-bottom:6px;}
.form-group input,.form-group textarea,.form-group select{
width:100%;padding:10px 14px;background:#0f0f0f;border:1px solid #333;
border-radius:8px;color:white;font-size:14px;outline:none;transition:border 0.2s;}
.form-group input:focus,.form-group textarea:focus{border-color:#25D366;}
.form-group textarea{resize:vertical;min-height:100px;font-family:'Segoe UI',sans-serif;}
.save-btn{background:#25D366;color:black;border:none;padding:10px 24px;border-radius:8px;
font-size:14px;font-weight:bold;cursor:pointer;margin-top:5px;}
.save-btn:hover{background:#1ebe57;}
.product-card{background:#0f0f0f;border-radius:10px;padding:18px;margin-bottom:12px;border:1px solid #222;}
.product-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.product-name{font-size:16px;font-weight:bold;color:white;}
.toggle{position:relative;width:44px;height:24px;}
.toggle input{opacity:0;width:0;height:0;}
.slider{position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;
background:#333;border-radius:24px;transition:.4s;}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;
background:white;border-radius:50%;transition:.4s;}
input:checked+.slider{background:#25D366;}
input:checked+.slider:before{transform:translateX(20px);}
.feature-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.feature-tag{background:#1a1a1a;border:1px solid #333;border-radius:6px;
padding:4px 10px;font-size:12px;color:#aaa;display:flex;align-items:center;gap:5px;}
.feature-tag button{background:none;border:none;color:#e74c3c;cursor:pointer;font-size:14px;}
.feature-input{display:flex;gap:8px;margin-top:8px;}
.feature-input input{flex:1;}
.feature-input button{background:#25D366;color:black;border:none;border-radius:8px;
padding:8px 14px;cursor:pointer;font-weight:bold;}
.page{display:none;}
.page.active{display:block;}
.empty{text-align:center;color:#444;padding:30px;font-size:14px;}
.revenue-card{background:linear-gradient(135deg,#1a2e1a,#1a1a2e);border-radius:12px;
padding:20px;text-align:center;border:1px solid #25D36640;margin-bottom:20px;}
.revenue-card h2{color:#f39c12;font-size:36px;font-weight:bold;}
.revenue-card p{color:#aaa;font-size:13px;margin-top:5px;}
.msg-modal{display:none;position:fixed;top:0;left:0;right:0;bottom:0;
background:#000000aa;z-index:200;align-items:center;justify-content:center;}
.msg-modal.show{display:flex;}
.msg-box{background:#1a1a1a;border-radius:16px;padding:25px;width:90%;max-width:400px;border:1px solid #333;}
.msg-box h3{margin-bottom:15px;color:white;}
.toast{position:fixed;bottom:20px;right:20px;background:#25D366;color:black;
padding:12px 20px;border-radius:10px;font-weight:bold;font-size:14px;z-index:999;
display:none;animation:slideIn 0.3s ease;}
@keyframes slideIn{from{transform:translateY(20px);opacity:0;}to{transform:translateY(0);opacity:1;}}
@media(max-width:768px){
.sidebar{width:60px;}
.sidebar-logo p,.nav-item:not(.active) span+*{display:none;}
.nav-item{justify-content:center;}
.main{margin-left:60px;padding:15px;}
.stats-grid{grid-template-columns:repeat(2,1fr);}
}
</style>
</head>
<body>

<!-- Sidebar -->
<div class="sidebar">
<div class="sidebar-logo">
<h2>🏪 Mega</h2>
<p>Admin Panel</p>
</div>
<div class="nav-item active" onclick="showPage('orders')"><span>📦</span> Orders</div>
<div class="nav-item" onclick="showPage('products')"><span>🎨</span> Products</div>
<div class="nav-item" onclick="showPage('payment')"><span>💳</span> Payment</div>
<div class="nav-item" onclick="showPage('prompt')"><span>🤖</span> AI Prompt</div>
<div class="nav-item" onclick="showPage('settings')"><span>⚙️</span> Settings</div>
<div class="nav-item" onclick="window.location='/qr'"><span>📱</span> QR Code</div>
<div class="nav-item" onclick="window.location='/logout'"><span>🚪</span> Logout</div>
</div>

<!-- Main Content -->
<div class="main">
<div class="topbar">
<h1 id="pageTitle">📦 Orders</h1>
<div>
<span class="bot-badge" id="botBadge">⏳ Loading...</span>
</div>
</div>

<!-- Stats -->
<div class="stats-grid" id="statsGrid"></div>

<!-- Revenue -->
<div class="revenue-card" id="revenueCard">
<p>💰 Total Revenue</p>
<h2 id="revenue">PKR 0</h2>
<p id="revenueDetail">0 orders approved</p>
</div>

<!-- ORDERS PAGE -->
<div class="page active" id="page-orders">
<div class="section">
<div class="section-header"><h3>⏳ Pending Orders</h3></div>
<div class="section-body" id="pendingOrders"><div class="empty">Loading...</div></div>
</div>
<div class="section">
<div class="section-header"><h3>✅ Approved Orders</h3></div>
<div class="section-body" id="approvedOrders"><div class="empty">Loading...</div></div>
</div>
<div class="section">
<div class="section-header"><h3>❌ Rejected Orders</h3></div>
<div class="section-body" id="rejectedOrders"><div class="empty">Loading...</div></div>
</div>
</div>

<!-- PRODUCTS PAGE -->
<div class="page" id="page-products">
<div class="section">
<div class="section-header">
<h3>🎨 Products</h3>
<button class="btn btn-green" onclick="addProduct()">+ Add Product</button>
</div>
<div class="section-body" id="productsList"></div>
</div>
</div>

<!-- PAYMENT PAGE -->
<div class="page" id="page-payment">
<div class="section">
<div class="section-header"><h3>💳 Payment Details</h3></div>
<div class="section-body">
<h4 style="color:#aaa;margin-bottom:15px">📱 EasyPaisa</h4>
<div class="form-group"><label>Number</label><input id="ep_number" placeholder="03XX-XXXXXXX"/></div>
<div class="form-group"><label>Account Name</label><input id="ep_name" placeholder="Tumhara Naam"/></div>
<h4 style="color:#aaa;margin:15px 0">📱 JazzCash</h4>
<div class="form-group"><label>Number</label><input id="jc_number" placeholder="03XX-XXXXXXX"/></div>
<div class="form-group"><label>Account Name</label><input id="jc_name" placeholder="Tumhara Naam"/></div>
<h4 style="color:#aaa;margin:15px 0">🏦 Bank Account</h4>
<div class="form-group"><label>Bank Name</label><input id="bank_name" placeholder="HBL"/></div>
<div class="form-group"><label>Account Number</label><input id="bank_acc" placeholder="XXXXXXXXXXXXXXX"/></div>
<div class="form-group"><label>Account Holder Name</label><input id="bank_holder" placeholder="Tumhara Naam"/></div>
<div class="form-group"><label>IBAN</label><input id="bank_iban" placeholder="PK00XXXX..."/></div>
<button class="save-btn" onclick="savePayment()">💾 Save Payment Details</button>
</div>
</div>
</div>

<!-- AI PROMPT PAGE -->
<div class="page" id="page-prompt">
<div class="section">
<div class="section-header"><h3>🤖 AI Sales Agent Prompt</h3></div>
<div class="section-body">
<p style="color:#aaa;font-size:13px;margin-bottom:15px">
⚠️ Yahan se AI ka behavior control kar sakte ho. ORDER_READY word zaroor rakho.
</p>
<div class="form-group">
<label>System Prompt</label>
<textarea id="aiPrompt" rows="20"></textarea>
</div>
<button class="save-btn" onclick="savePrompt()">💾 Save Prompt</button>
</div>
</div>
</div>

<!-- SETTINGS PAGE -->
<div class="page" id="page-settings">
<div class="section">
<div class="section-header"><h3>⚙️ Settings</h3></div>
<div class="section-body">
<div class="form-group"><label>Business Name</label><input id="s_bizName" placeholder="Mega Agency"/></div>
<div class="form-group"><label>Admin WhatsApp Number (92XXXXXXXXXX)</label><input id="s_adminNum" placeholder="923001234567"/></div>
<div class="form-group"><label>Dashboard Password</label><input id="s_password" type="password" placeholder="New password..."/></div>
<button class="save-btn" onclick="saveSettings()">💾 Save Settings</button>
</div>
</div>
</div>
</div>

<!-- Message Modal -->
<div class="msg-modal" id="msgModal">
<div class="msg-box">
<h3>💬 Custom Message Bhejo</h3>
<input type="hidden" id="msgJid"/>
<div class="form-group"><label>Message</label><textarea id="msgText" rows="4" placeholder="Yahan message likho..."></textarea></div>
<div class="btn-row">
<button class="btn btn-green" onclick="sendCustomMsg()">📤 Send</button>
<button class="btn btn-gray" onclick="closeModal()">Cancel</button>
</div>
</div>
</div>

<!-- Toast -->
<div class="toast" id="toast">✅ Saved!</div>

<script>
let allData = {};
let products = [];

// Load data
async function loadData() {
    const r = await fetch('/api/data');
    allData = await r.json();
    products = allData.products || [];
    renderAll();
}

function renderAll() {
    // Bot status
    const badge = document.getElementById('botBadge');
    badge.className = 'bot-badge ' + (allData.botStatus === 'connected' ? 'badge-live' : 'badge-off');
    badge.textContent = allData.botStatus === 'connected' ? '🟢 Bot Live' : '🔴 ' + allData.botStatus;

    // Stats
    const s = allData.stats || {};
    document.getElementById('statsGrid').innerHTML = \`
    <div class="stat-card" style="border-top:3px solid #f39c12">
    <h2 style="color:#f39c12">\${s.pending||0}</h2><p>⏳ Pending</p></div>
    <div class="stat-card" style="border-top:3px solid #25D366">
    <h2 style="color:#25D366">\${s.approved||0}</h2><p>✅ Approved</p></div>
    <div class="stat-card" style="border-top:3px solid #e74c3c">
    <h2 style="color:#e74c3c">\${s.rejected||0}</h2><p>❌ Rejected</p></div>
    <div class="stat-card" style="border-top:3px solid #9b59b6">
    <h2 style="color:#9b59b6">\${s.total||0}</h2><p>📦 Total</p></div>\`;

    document.getElementById('revenue').textContent = 'PKR ' + (s.revenue||0).toLocaleString();
    document.getElementById('revenueDetail').textContent = (s.approved||0) + ' orders approved';

    renderOrders();
    renderProducts();
    renderPayment();
    renderPrompt();
    renderSettings();
}

function renderOrders() {
    const orders = Object.values(allData.orders || {});
    const pending = orders.filter(o => o.status === 'pending');
    const approved = orders.filter(o => o.status === 'approved');
    const rejected = orders.filter(o => o.status === 'rejected');

    document.getElementById('pendingOrders').innerHTML = pending.length === 0
        ? '<div class="empty">Koi pending order nahi</div>'
        : pending.map(o => orderCard(o)).join('');

    document.getElementById('approvedOrders').innerHTML = approved.length === 0
        ? '<div class="empty">Koi approved order nahi</div>'
        : approved.map(o => orderCard(o)).join('');

    document.getElementById('rejectedOrders').innerHTML = rejected.length === 0
        ? '<div class="empty">Koi rejected order nahi</div>'
        : rejected.map(o => orderCard(o)).join('');
}

function orderCard(o) {
    const time = new Date(o.timestamp).toLocaleString('en-PK');
    const badgeClass = o.status === 'pending' ? 'bp' : o.status === 'approved' ? 'ba' : 'br';
    const actions = o.status === 'pending' ? \`
    <button class="btn btn-green" onclick="approveOrder(\${o.orderId})">✅ Approve</button>
    <button class="btn btn-red" onclick="rejectOrder(\${o.orderId})">❌ Reject</button>
    <button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>
    \` : \`<button class="btn btn-blue" onclick="openMsg('\${o.customerJid}')">💬 Message</button>\`;

    return \`<div class="order-card \${o.status}">
    <div class="order-header">
    <span class="order-id">#\${o.orderId}</span>
    <span class="badge \${badgeClass}">\${o.status.toUpperCase()}</span>
    </div>
    <div class="order-info">
    📱 Number: <b>\${o.customerNumber}</b><br>
    👤 Name: <b>\${o.customerName || 'N/A'}</b><br>
    📸 Screenshot: <b>\${o.hasScreenshot ? '✅ Received' : '❌ Pending'}</b><br>
    📅 Time: <b>\${time}</b>
    </div>
    <div class="btn-row">\${actions}</div>
    </div>\`;
}

async function approveOrder(id) {
    if(!confirm('Order #' + id + ' approve karo?')) return;
    await fetch('/api/approve/' + id, {method:'POST'});
    showToast('✅ Order Approved!');
    loadData();
}

async function rejectOrder(id) {
    if(!confirm('Order #' + id + ' reject karo?')) return;
    await fetch('/api/reject/' + id, {method:'POST'});
    showToast('❌ Order Rejected!');
    loadData();
}

function renderProducts() {
    const el = document.getElementById('productsList');
    if (!products.length) { el.innerHTML = '<div class="empty">Koi product nahi</div>'; return; }
    el.innerHTML = products.map((p, i) => \`
    <div class="product-card">
    <div class="product-header">
    <span class="product-name">\${p.name}</span>
    <label class="toggle">
    <input type="checkbox" \${p.active ? 'checked' : ''} onchange="toggleProduct(\${i})"/>
    <span class="slider"></span>
    </label>
    </div>
    <div class="form-group"><label>Product Name</label>
    <input value="\${p.name}" onchange="products[\${i}].name=this.value"/></div>
    <div class="form-group"><label>Price (PKR)</label>
    <input type="number" value="\${p.price}" onchange="products[\${i}].price=parseInt(this.value)"/></div>
    <div class="form-group"><label>Description</label>
    <textarea onchange="products[\${i}].description=this.value">\${p.description}</textarea></div>
    <div class="form-group"><label>Download Link</label>
    <input value="\${p.downloadLink||''}" placeholder="https://drive.google.com/..." onchange="products[\${i}].downloadLink=this.value"/></div>
    <div class="form-group"><label>Features</label>
    <div class="feature-list" id="features_\${i}">
    \${(p.features||[]).map((f,j) => \`<div class="feature-tag">\${f}<button onclick="removeFeature(\${i},\${j})">×</button></div>\`).join('')}
    </div>
    <div class="feature-input">
    <input id="newFeature_\${i}" placeholder="New feature..." onkeypress="if(event.key==='Enter')addFeature(\${i})"/>
    <button onclick="addFeature(\${i})">+ Add</button>
    </div></div>
    <div class="btn-row">
    <button class="btn btn-green" onclick="saveProducts()">💾 Save</button>
    <button class="btn btn-red" onclick="removeProduct(\${i})">🗑️ Delete</button>
    </div>
    </div>\`).join('');
}

function toggleProduct(i) { products[i].active = !products[i].active; }
function addFeature(i) {
    const input = document.getElementById('newFeature_' + i);
    if (!input.value.trim()) return;
    if (!products[i].features) products[i].features = [];
    products[i].features.push(input.value.trim());
    input.value = '';
    renderProducts();
}
function removeFeature(i, j) { products[i].features.splice(j, 1); renderProducts(); }
function addProduct() {
    products.push({ id: Date.now(), name: 'New Product', price: 999, description: '', features: [], downloadLink: '', active: false });
    renderProducts();
}
function removeProduct(i) { if(confirm('Delete karo?')) { products.splice(i, 1); renderProducts(); } }
async function saveProducts() {
    await fetch('/api/products', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(products) });
    showToast('✅ Products Saved!');
    loadData();
}

function renderPayment() {
    const p = allData.payment || {};
    document.getElementById('ep_number').value = p.easypaisa?.number || '';
    document.getElementById('ep_name').value = p.easypaisa?.name || '';
    document.getElementById('jc_number').value = p.jazzcash?.number || '';
    document.getElementById('jc_name').value = p.jazzcash?.name || '';
    document.getElementById('bank_name').value = p.bank?.bankName || '';
    document.getElementById('bank_acc').value = p.bank?.accountNumber || '';
    document.getElementById('bank_holder').value = p.bank?.accountName || '';
    document.getElementById('bank_iban').value = p.bank?.iban || '';
}
async function savePayment() {
    const data = {
        easypaisa: { number: document.getElementById('ep_number').value, name: document.getElementById('ep_name').value },
        jazzcash: { number: document.getElementById('jc_number').value, name: document.getElementById('jc_name').value },
        bank: { bankName: document.getElementById('bank_name').value, accountNumber: document.getElementById('bank_acc').value, accountName: document.getElementById('bank_holder').value, iban: document.getElementById('bank_iban').value }
    };
    await fetch('/api/payment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    showToast('✅ Payment Details Saved!');
}

function renderPrompt() { document.getElementById('aiPrompt').value = allData.aiPrompt || ''; }
async function savePrompt() {
    const prompt = document.getElementById('aiPrompt').value;
    await fetch('/api/prompt', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt }) });
    showToast('✅ AI Prompt Saved!');
}

function renderSettings() {
    const s = allData.settings || {};
    document.getElementById('s_bizName').value = s.businessName || '';
    document.getElementById('s_adminNum').value = s.adminNumber || '';
}
async function saveSettings() {
    const data = {
        businessName: document.getElementById('s_bizName').value,
        adminNumber: document.getElementById('s_adminNum').value,
        dashboardPassword: document.getElementById('s_password').value || allData.settings?.dashboardPassword
    };
    await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
    showToast('✅ Settings Saved!');
}

function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    event.currentTarget.classList.add('active');
    const titles = { orders:'📦 Orders', products:'🎨 Products', payment:'💳 Payment', prompt:'🤖 AI Prompt', settings:'⚙️ Settings' };
    document.getElementById('pageTitle').textContent = titles[page] || page;
    const showStats = ['orders'].includes(page);
    document.getElementById('statsGrid').style.display = showStats ? 'grid' : 'none';
    document.getElementById('revenueCard').style.display = showStats ? 'block' : 'none';
}

function openMsg(jid) { document.getElementById('msgJid').value = jid; document.getElementById('msgModal').classList.add('show'); }
function closeModal() { document.getElementById('msgModal').classList.remove('show'); }
async function sendCustomMsg() {
    const jid = document.getElementById('msgJid').value;
    const message = document.getElementById('msgText').value;
    if (!message.trim()) return;
    await fetch('/api/send-message', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ jid, message }) });
    showToast('✅ Message Sent!');
    closeModal();
    document.getElementById('msgText').value = '';
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 3000);
}

loadData();
setInterval(loadData, 15000);
</script>
</body></html>`);
        return;
    }

    res.writeHead(302, { Location: '/dashboard' });
    res.end();
});

server.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Server ready!');
    console.log('📊 Dashboard: /dashboard');
    console.log('📱 QR: /qr');
});

// ─────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────
async function handleMessage(sock, message) {
    try {
        if (message.key.fromMe) return;

        const senderId = message.key.remoteJid;
        const senderName = message.pushName || 'Customer';
        const msgType = Object.keys(message.message || {})[0];

        if (msgType === 'imageMessage') {
            const existingOrder = Object.values(botData.orders).find(
                o => o.customerJid === senderId && o.status === 'pending'
            );
            if (existingOrder) {
                existingOrder.hasScreenshot = true;
                saveData();
                await sock.sendMessage(senderId, {
                    text: `📸 *Screenshot Receive Ho Gaya!*\n\nOrder *#${existingOrder.orderId}*\n\n✅ Admin verify kar raha hai\n⏳ 1 hour mein themes deliver honge!\n\nShukriya! 🙏`
                });
                const adminJid = botData.settings.adminNumber + '@s.whatsapp.net';
                try {
                    await sock.sendMessage(adminJid, {
                        text: `🔔 *New Payment Screenshot!*\n\nOrder: *#${existingOrder.orderId}*\nCustomer: ${senderName}\nNumber: ${existingOrder.customerNumber}\n\nDashboard pe approve/reject karo! ⚡`
                    });
                } catch (e) {}
            } else {
                const aiReply = await getAISalesResponse('[Customer ne image bheja bina order ke]', senderId, senderName);
                await sock.sendMessage(senderId, { text: aiReply.message });
            }
            return;
        }

        const userMessage = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
        if (!userMessage.trim()) return;

        console.log(`📩 ${senderName}: ${userMessage}`);
        await sock.sendPresenceUpdate('composing', senderId);

        const aiReply = await getAISalesResponse(userMessage, senderId, senderName);
        await sock.sendPresenceUpdate('paused', senderId);

        if (aiReply.shouldOrder) {
            botData.orderCounter++;
            const orderId = botData.orderCounter;
            const product = aiReply.product || botData.products[0];
            botData.orders[senderId] = {
                orderId,
                customerJid: senderId,
                customerNumber: senderId.replace('@s.whatsapp.net', ''),
                customerName: senderName,
                productId: product?.id,
                status: 'pending',
                hasScreenshot: false,
                timestamp: Date.now()
            };
            saveData();
            if (aiReply.message) {
                await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
                await new Promise(r => setTimeout(r, 1500));
            }
            await sock.sendMessage(senderId, { text: getPaymentMessage(orderId, product) });
            console.log(`🛒 New Order: #${orderId} for ${senderName}`);
        } else {
            await sock.sendMessage(senderId, { text: aiReply.message }, { quoted: message });
        }
    } catch (err) {
        console.error('Handle error:', err.message);
    }
}

// ─────────────────────────────────────────
// WHATSAPP BOT
// ─────────────────────────────────────────
async function startBot() {
    try {
        try { fs.rmSync('/tmp/auth_info', { recursive: true, force: true }); } catch (e) {}

        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`📱 WA Version: ${version.join('.')} — Latest: ${isLatest}`);

        const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info');

        const sock = makeWASocket({
            version, auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            emitOwnEvents: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            qrTimeout: 60000,
            retryRequestDelayMs: 2000,
            maxMsgRetryCount: 5,
            fireInitQueries: true,
            syncFullHistory: false
        });

        sockGlobal = sock;
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { currentQR = qr; botStatus = 'qr_ready'; console.log('✅ QR Ready!'); }
            if (connection === 'close') {
                currentQR = null;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Disconnected, code:', code);
                if (code === DisconnectReason.loggedOut) {
                    botStatus = 'logged_out';
                    try { fs.rmSync('/tmp/auth_info', { recursive: true, force: true }); } catch (e) {}
                    setTimeout(startBot, 5000);
                } else {
                    botStatus = 'reconnecting';
                    setTimeout(startBot, code === 405 ? 15000 : 10000);
                }
            }
            if (connection === 'open') {
                currentQR = null; botStatus = 'connected';
                console.log('✅ WhatsApp Connected! Mega Agency LIVE!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const message of messages) await handleMessage(sock, message);
        });

    } catch (err) {
        console.error('Bot error:', err.message);
        setTimeout(startBot, 15000);
    }
}

console.log('🚀 Mega Agency AI Sales Bot start ho raha hai...');
startBot();
