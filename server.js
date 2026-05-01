async function connectWhatsApp() {
  const authDir = path.join('/tmp', 'auth_info');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ['Fleet Motors', 'Chrome', '1.0'],
    mobile: false
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = qr;
      isConnected = false;
      // Gera pairing code automaticamente
      try {
        const number = process.env.WPP_NUMBER || '';
        if (number && !sock.authState.creds.registered) {
          const code = await sock.requestPairingCode(number);
          pairingCode = code;
          console.log(`📱 Pairing Code: ${code}`);
        }
      } catch(e) {
        console.log('QR disponível em /qr');
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
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
      if (!telefone) continue;
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

  sock.ev.on('creds.update', saveCreds);
}