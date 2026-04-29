const express = require('express');
const axios = require('axios');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 3000;
const EVOLUTION_URL  = process.env.EVOLUTION_URL;
const EVOLUTION_KEY  = process.env.EVOLUTION_KEY;
const EVOLUTION_INST = process.env.EVOLUTION_INSTANCE || 'fleet-motors';
const CLAUDE_KEY     = process.env.CLAUDE_API_KEY;
const FIREBASE_JSON  = process.env.FIREBASE_SERVICE_ACCOUNT; // JSON string

// ── FIREBASE INIT ─────────────────────────────────────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(FIREBASE_JSON);
  initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore();
  console.log('✅ Firebase conectado');
} catch(e) {
  console.warn('⚠️  Firebase não configurado:', e.message);
}

// ── MEMÓRIA DE CONVERSAS ──────────────────────────────────────────────────
// { telefone: [ {role, content}, ... ] }
const conversas = {};

// ── BUSCA ESTOQUE ─────────────────────────────────────────────────────────
async function getEstoque() {
  if (!db) return 'Estoque não disponível.';
  try {
    const snap = await db.collection('estoque')
      .where('status', '==', 'disponivel')
      .orderBy('criadoEm', 'desc')
      .get();

    if (snap.empty) return 'Nenhum veículo disponível no momento.';

    return snap.docs.map(d => {
      const c = d.data();
      const preco = c.preco ? 'R$ ' + c.preco.toLocaleString('pt-BR') : 'consultar';
      const km    = c.km    ? c.km.toLocaleString('pt-BR') + ' km'    : '';
      const fotos = (c.imagens && c.imagens.length) ? '\n  fotos: ' + c.imagens.join(', ') : '';
      return `• ${c.nome||'?'} ${c.ano||''} — ${km} — ${preco}${c.versao?' | '+c.versao:''}${c.comb?' | '+c.comb:''}${fotos}`;
    }).join('\n');
  } catch(e) {
    console.error('Erro estoque:', e);
    return 'Estoque temporariamente indisponível.';
  }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────
function buildSystem(estoque) {
  return `Você é Mateus, consultor de vendas da Fleet Motors — concessionária multimarcas premium no Brasil.

Você atende clientes pelo WhatsApp de forma natural e humana.

FLUXO DE ATENDIMENTO:
1. Cumprimente o cliente de forma calorosa e natural
2. Entenda a intenção: quer comprar, vender ou financiar?
3. Qualifique: faixa de preço e preferência de carro
4. Apresente opções do estoque abaixo
5. Ofereça enviar as fotos dos veículos de interesse
6. Se necessário, explique sobre financiamento
7. Incentive uma visita presencial para test drive
8. Feche um agendamento com data e horário

REGRAS:
- Nunca use menus numerados ou listas robóticas
- Seja natural, como um vendedor humano
- Respostas curtas — máximo 3 parágrafos
- Use emojis com moderação (1-2 por mensagem)
- Nunca pressione o cliente — guie com sutileza
- Quando mencionar um carro, inclua o link da foto se disponível
- Número da Fleet Motors para agendamento: +55 21 99549-5871

ESTOQUE ATUAL:
${estoque}`;
}

// ── ENVIA MENSAGEM WHATSAPP ───────────────────────────────────────────────
async function sendWpp(telefone, texto) {
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INST}`,
      { number: telefone, text: texto },
      { headers: { apikey: EVOLUTION_KEY } }
    );
  } catch(e) {
    console.error('Erro ao enviar mensagem:', e.response?.data || e.message);
  }
}

// ── CHAMA CLAUDE ─────────────────────────────────────────────────────────
async function askClaude(system, messages) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system,
      messages
    },
    {
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );
  return res.data.content[0].text;
}

// ── WEBHOOK ───────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pro Evolution não reenviar

  try {
    const body = req.body;

    // ignora eventos que não são mensagens recebidas
    if (body.event !== 'messages.upsert') return;

    const msg = body.data?.message;
    if (!msg) return;

    // ignora mensagens enviadas por nós
    if (msg.key?.fromMe) return;

    const telefone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '');
    if (!telefone) return;

    // pega o texto da mensagem
    const texto =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.buttonsResponseMessage?.selectedDisplayText ||
      null;

    if (!texto) return; // ignora áudios, imagens, etc por ora

    console.log(`📩 [${telefone}]: ${texto}`);

    // inicializa histórico se necessário
    if (!conversas[telefone]) conversas[telefone] = [];

    // adiciona mensagem do usuário
    conversas[telefone].push({ role: 'user', content: texto });

    // limita histórico a 20 mensagens para não explodir tokens
    if (conversas[telefone].length > 20) {
      conversas[telefone] = conversas[telefone].slice(-20);
    }

    // busca estoque atualizado
    const estoque = await getEstoque();
    const system  = buildSystem(estoque);

    // chama Claude
    const resposta = await askClaude(system, conversas[telefone]);

    // adiciona resposta ao histórico
    conversas[telefone].push({ role: 'assistant', content: resposta });

    console.log(`🤖 → [${telefone}]: ${resposta.substring(0, 80)}...`);

    // envia resposta pelo WhatsApp
    await sendWpp(telefone, resposta);

  } catch(e) {
    console.error('Erro no webhook:', e.message);
  }
});

// ── QR CODE ENDPOINT ──────────────────────────────────────────────────────
app.get('/qrcode', async (req, res) => {
  try {
    const r = await axios.get(
      `${EVOLUTION_URL}/instance/connect/${EVOLUTION_INST}`,
      { headers: { apikey: EVOLUTION_KEY } }
    );
    res.json(r.data);
  } catch(e) {
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

// ── STATUS ────────────────────────────────────────────────────────────────
app.get('/status', async (req, res) => {
  try {
    const r = await axios.get(
      `${EVOLUTION_URL}/instance/connectionState/${EVOLUTION_INST}`,
      { headers: { apikey: EVOLUTION_KEY } }
    );
    res.json({ ok: true, state: r.data });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send(`
    <h2>Fleet Motors Agent 🚗</h2>
    <p>Status: <a href="/status">ver conexão</a></p>
    <p>QR Code: <a href="/qrcode">conectar WhatsApp</a></p>
    <p>Webhook: POST /webhook</p>
  `);
});

app.listen(PORT, () => console.log(`🚀 Fleet Agent rodando na porta ${PORT}`));
