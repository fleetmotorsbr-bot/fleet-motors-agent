const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());

// ── CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CONFIG
const PORT       = process.env.PORT || 3000;
const CLAUDE_KEY = process.env.CLAUDE_API_KEY;
const FIREBASE_JSON = process.env.FIREBASE_SERVICE_ACCOUNT;
const ZAPI_INST  = process.env.ZAPI_INSTANCE || '3F264304076872FBFFCF62108CBB360D';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN    || '77BAEC435D5417876E2AE81F';

// ── FIREBASE
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
      const km    = c.km    ? c.km.toLocaleString('pt-BR') + ' km' : '';
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
  return `Você é Vitor, consultor de vendas da Fleet Motors — concessionária multimarcas premium no Brasil.
Atende clientes pelo WhatsApp de forma natural e humana.
Fluxo: boas-vindas → intenção → qualificação → apresentar estoque → fotos → financiamento → visita → agendamento.
Nunca use listas robóticas. Respostas curtas. Máx 3 parágrafos. 1-2 emojis.
Número Fleet Motors: +55 21 99549-5871
ESTOQUE:\n${estoque}`;
}

async function sendWpp(telefone, texto) {
  try {
    await axios.post(
      `https://api.z-api.io/instances/${ZAPI_INST}/token/${ZAPI_TOKEN}/send-text`,
      { phone: telefone, message: texto },
      { headers: { 'Client-Token': ZAPI_TOKEN } }
    );
    console.log(`✅ Mensagem enviada para ${telefone}`);
  } catch(e) {
    console.error('Erro Z-API:', e.response?.data || e.message);
  }
}

async function askClaude(system, messages) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-20250514', max_tokens: 1024, system, messages },
    { headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
  );
  return res.data.content[0].text;
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.fromMe || body.isFromMe) return;
    const telefone = body.phone || body.chatId?.replace('@c.us','') || body.from;
    if (!telefone) return;
    const texto = body.text?.message || body.body || body.message;
    if (!texto) return;

    console.log(`📩 [${telefone}]: ${texto}`);
    await salvarMensagem(telefone, 'user', texto);

    if (!conversas[telefone]) conversas[telefone] = [];
    conversas[telefone].push({ role: 'user', content: texto });
    if (conversas[telefone].length > 20) conversas[telefone] = conversas[telefone].slice(-20);

    const estoque  = await getEstoque();
    const system   = buildSystem(estoque);
    const resposta = await askClaude(system, conversas[telefone]);

    conversas[telefone].push({ role: 'assistant', content: resposta });
    await salvarMensagem(telefone, 'assistant', resposta);
    await sendWpp(telefone, resposta);

  } catch(e) {
    console.error('Erro webhook:', e.message);
  }
});

app.get('/status', async (req, res) => {
  try {
    const r = await axios.get(
      `https://api.z-api.io/instances/${ZAPI_INST}/token/${ZAPI_TOKEN}/status`,
      { headers: { 'Client-Token': ZAPI_TOKEN } }
    );
    res.json({ ok: true, state: r.data });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/enviar', async (req, res) => {
  const { telefone, mensagem } = req.body;
  if (!telefone || !mensagem) return res.status(400).json({ error: 'faltam dados' });
  try {
    await sendWpp(telefone, mensagem);
    await salvarMensagem(telefone, 'assistant', mensagem);
    if (!conversas[telefone]) conversas[telefone] = [];
    conversas[telefone].push({ role: 'assistant', content: mensagem });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send('<h2>Fleet Motors Agent 🚗</h2><p>Online. Webhook: POST /webhook</p>');
});

app.listen(PORT, () => console.log(`🚀 Fleet Agent porta ${PORT}`));