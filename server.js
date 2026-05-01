const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const PORT = process.env.PORT || 3000;
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
const FIREBASE_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const WPP_NUMBER = process.env.WPP_NUMBER || '';

let db;
try {
  const serviceAccount = JSON.parse(FIREBASE_JSON);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log('✅ Firebase conectado');
} catch(e) {
  console.warn('⚠️ Firebase não configurado:', e.message);
}

const conversas = {};
let sock = null;
let qrCode = null;
let pairingCode = null;
let isConnected = false;

async function getEstoque() {
  if (!db) return 'Estoque não disponível.';
  try {
    const snap = await db.collection('estoque')
      .where('status', '==', 'disponivel')
      .orderBy('criadoEm', 'desc')
      .get();
    if (snap.empty) return 'Nenhum veículo disponível.';
    return snap.docs.map(d => {
      const c = d.data();
      const preco = c.preco ? 'R$ ' + c.preco.toLocaleString('pt-BR') : 'consultar';
      const km = c.km ? c.km.toLocaleString('pt-BR') + ' km' : '';
      const fotos = (c.imagens && c.imagens.length) ? ' fotos: ' + c.imagens.join(', ') : '';
      return `• ${c.nome||'?'} ${c.ano||''} — ${km} — ${preco}${c.versao?' | '+c.versao:''}${fotos}`;
    }).join('\n');
  } catch(e) {
    return 'Estoque indisponível.';
  }
}

async function salvarMensagem(telefone, role, texto) {
  if (!db) return;
  try {
    const ref = db.collection('conversas_whatsapp').doc(telefone);
    const doc = await ref.get();
    const msgs = doc.exists ? (doc.data().mensagens || []) : [];
    msgs.push({ role, texto, timestamp: new Date() });
    await ref.set({
      telefone,
      ultimaMensagem: texto,
      ultimaAtualizacao: new Date(),
      mensagens: msgs.slice(-50)
    }, { merge: true });
  } catch(e) {
    console.error('Erro salvar:', e);
  }
}

function buildSystem(estoque) {
  return `Você é Mateus, consultor de vendas da Fleet Motors — concessionária multimarcas premium no Brasil.
Atende clientes pelo WhatsApp de forma natural e humana.
Fluxo: boas-vindas → intenção → qualificação → apresentar estoque → fotos → financiamento → visita → agendamento.
Nunca use listas robóticas. Respostas curtas. Máx 3 parágrafos. 1-2 emojis.
Número Fleet Motors: +55 21 99549-5871
ESTOQUE:\n${estoque}`;
}

async function askClaude(system, messages) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 1024, system, messages },
    { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  return res.data.content[0].text;
}

async function connectWhatsApp() {
  const authDir = path.join('/tmp', 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Fleet Motors', 'Chrome', '1.0']
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      isConnected = false;
      if (WPP_NUMBER && !sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(WPP_NUMBER);
          pairingCode = code;
          console.log(`📱 Pairing Code: ${code}`);
        } catch(e) {
          console.log('Erro pairing code:', e.message);
        }
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('❌ Desconectado. Reconectando:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectWhatsApp, 5000);
    }

    if (connection === 'open') {
      isConnected = true;
      qrCode = null;
      pairingCode = null;
      console.log('✅ WhatsApp conectado!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const telefone = msg.key.remoteJid?.replace('@s.whatsapp.net', '');
      if (!telefone || telefone === 'status') continue;
      const texto = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
      if (!texto) continue;
      console.log(`📩 [${telefone}]: ${texto}`);
      await salvarMensagem(telefone, 'user', texto);
      if (!conversas[telefone]) conversas[telefone] = [];
      conversas[telefone].push({ role: 'user', content: texto });
      if (conversas[telefone].length > 20) conversas[telefone] = conversas[telefone].slice(-20);
      try {
        const estoque = await getEstoque();
        const system = buildSystem(estoque);
        const resposta = await askClaude(system, conversas[telefone]);
        conversas[telefone].push({ role: 'assistant', content: resposta });
        await salvarMensagem(telefone, 'assistant', resposta);
        await sock.sendMessage(`${telefone}@s.whatsapp.net`, { text: resposta });
        console.log(`✅ Resposta enviada para ${telefone}`);
      } catch(e) {
        console.error('Erro ao responder:', e.message);
      }
    }
  });
}

app.get('/', (req, res) => {
  res.send(`
    <h2>Fleet Motors Agent 🚗</h2>
    <p>Status: ${isConnected ? '✅ Conectado' : '❌ Desconectado'}</p>
    ${!isConnected ? '<p><a href="/qr">Conectar WhatsApp</a></p>' : ''}
  `);
});

app.get('/qr', (req, res) => {
  if (isConnected) return res.send(`
    <h2 style="font-family:sans-serif;color:green">✅ WhatsApp Conectado!</h2>
    <p style="font-family:sans-serif">O agente está funcionando.</p>
  `);
  if (pairingCode) return res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>Código de Pareamento</h2>
      <h1 style="font-size:56px;letter-spacing:10px;color:#25D366;background:#f0f0f0;padding:20px;border-radius:12px">${pairingCode}</h1>
      <p>No WhatsApp: <b>Dispositivos conectados → Conectar com número de telefone</b></p>
      <p>Digite o código acima</p>
      <meta http-equiv="refresh" content="10">
    </div>
  `);
  if (qrCode) return res.send(`
    <div style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>Escaneie o QR Code</h2>
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qrCode)}" />
      <p>Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo</p>
      <meta http-equiv="refresh" content="30">
    </div>
  `);
  return res.send('<h2 style="font-family:sans-serif">Aguarde... gerando código</h2><meta http-equiv="refresh" content="3">');
});

app.get('/status', (req, res) => {
  res.json({ ok: true, connected: isConnected, qrPending: !!qrCode, pairingPending: !!pairingCode });
});

app.post('/enviar', async (req, res) => {
  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem) return res.status(400).json({ error: 'faltam dados' });
  if (!isConnected) return res.status(503).json({ error: 'WhatsApp desconectado' });
  try {
    await sock.sendMessage(`${telefone}@s.whatsapp.net`, { text: mensagem });
    await salvarMensagem(telefone, 'assistant', mensagem);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

connectWhatsApp();
app.listen(PORT, () => console.log(`🚀 Fleet Agent porta ${PORT}`));