require('dotenv').config();
const crypto = require('crypto');

// ─── Script de test local ───────────────────────────────────────────────────
//
// Simula el POST que envía el Trigger de Zendesk a /zendesk-reply.
//
// Uso:
//   node test-webhook.js <conversation_id>
//   CONVERSATION_ID=98765432109876 node test-webhook.js
//
// Si no se pasa ningún ID, se usa uno de prueba por defecto.

const conversationId = process.argv[2] || process.env.CONVERSATION_ID || '98765432109876';
const port = process.env.PORT || 3000;
const url = process.env.WEBHOOK_URL || `http://localhost:${port}/zendesk-reply`;
const zendeskSecret = process.env.ZENDESK_WEBHOOK_SECRET;

const payload = {
  ticket_id: '12345',
  ticket_subject: `Escalación Fin: ${conversationId}`,
  agent_reply: '<p>Hola, tu consulta fue resuelta. ¡Que tengas un excelente día!</p>',
  agent_name: 'María García'
};

const rawBody = JSON.stringify(payload);

const headers = { 'Content-Type': 'application/json' };

// Si hay un secreto configurado, firmamos el request igual que lo haría Zendesk,
// para poder probar también la validación de firma end-to-end.
if (zendeskSecret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac('sha256', zendeskSecret)
    .update(timestamp + rawBody)
    .digest('base64');

  headers['x-zendesk-webhook-signature'] = signature;
  headers['x-zendesk-webhook-signature-timestamp'] = timestamp;
}

async function main() {
  console.log(`Enviando webhook de prueba a ${url}`);
  console.log(`Conversation ID: ${conversationId}`);
  console.log(`Firma incluida : ${zendeskSecret ? 'sí' : 'no (ZENDESK_WEBHOOK_SECRET no está seteado)'}\n`);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: rawBody
    });

    const data = await response.json().catch(() => ({}));

    console.log(`Status: ${response.status}`);
    console.log('Respuesta:', JSON.stringify(data, null, 2));

    if (!response.ok) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error al conectar con ${url}:`, err.message);
    console.error('¿Está corriendo el servidor? (npm start / npm run dev)');
    process.exitCode = 1;
  }
}

main();
