require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const app = express();

// Guardamos el body raw (buffer) para poder validar la firma HMAC de Zendesk,
// ya que la validación necesita los bytes exactos recibidos, no el JSON re-serializado.
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const INTERCOM_TOKEN = process.env.INTERCOM_TOKEN;
const INTERCOM_ADMIN_ID = process.env.INTERCOM_ADMIN_ID;
const PORT = process.env.PORT || 3000;
const ZENDESK_WEBHOOK_SECRET = process.env.ZENDESK_WEBHOOK_SECRET;

const INTERCOM_TIMEOUT_MS = 10000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extrae el Intercom Conversation ID del subject del ticket de Zendesk.
 * Subject esperado: "Escalación Fin: 12345678901234"
 */
function extractConversationId(subject = '') {
  const match = subject.match(/Escalaci[oó]n Fin:\s*(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Valida la firma HMAC-SHA256 que envía Zendesk en el header
 * x-zendesk-webhook-signature (junto con x-zendesk-webhook-signature-timestamp).
 * Zendesk firma: HMAC-SHA256(secret, timestamp + raw_body) codificado en base64.
 *
 * Si ZENDESK_WEBHOOK_SECRET no está seteado, se salta la validación (modo dev).
 */
function isValidZendeskSignature(req) {
  if (!ZENDESK_WEBHOOK_SECRET) return { valid: true };

  const signature = req.get('x-zendesk-webhook-signature');
  const timestamp = req.get('x-zendesk-webhook-signature-timestamp');

  if (!signature || !timestamp || !req.rawBody) {
    // DEBUG TEMPORAL: nos falta ver si Zendesk manda estos headers con otro nombre.
    return {
      valid: false,
      reason: 'missing_headers',
      signaturePresent: !!signature,
      timestampPresent: !!timestamp,
      receivedHeaders: Object.keys(req.headers)
    };
  }

  const expected = crypto
    .createHmac('sha256', ZENDESK_WEBHOOK_SECRET)
    .update(timestamp + req.rawBody)
    .digest('base64');

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signature);

  const valid = expectedBuf.length === receivedBuf.length && crypto.timingSafeEqual(expectedBuf, receivedBuf);

  // DEBUG TEMPORAL: comparar firma esperada vs recibida cuando no matchea.
  return valid ? { valid: true } : { valid: false, reason: 'digest_mismatch', expected, received: signature, timestamp };
}

/**
 * Envía un reply a una conversación de Intercom.
 * Lanza errores enriquecidos con `status` para que el endpoint pueda
 * responder distinto según el tipo de fallo (404, 401, timeout, etc.).
 */
async function sendIntercomReply(conversationId, messageBody) {
  const url = `https://api.intercom.io/conversations/${conversationId}/reply`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), INTERCOM_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INTERCOM_TOKEN}`,
        'Content-Type': 'application/json',
        'Intercom-Version': '2.11'
      },
      body: JSON.stringify({
        message_type: 'comment',
        type: 'admin',
        admin_id: INTERCOM_ADMIN_ID,
        body: messageBody
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutError = new Error(`Timeout: Intercom no respondió en ${INTERCOM_TIMEOUT_MS / 1000}s`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(`Intercom API error ${response.status}: ${JSON.stringify(data)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

// ─── Endpoint principal ──────────────────────────────────────────────────────

/**
 * POST /zendesk-reply
 *
 * Payload esperado desde el Trigger de Zendesk:
 * {
 *   "ticket_id":      "{{ticket.id}}",
 *   "ticket_subject": "{{ticket.title}}",
 *   "agent_reply":    "{{ticket.latest_public_comment}}",
 *   "agent_name":     "{{current_user.name}}"
 * }
 */
app.post('/zendesk-reply', async (req, res) => {
  // Validar la firma del webhook (si ZENDESK_WEBHOOK_SECRET está configurado)
  const signatureCheck = isValidZendeskSignature(req);
  if (!signatureCheck.valid) {
    console.error(`\n[${new Date().toISOString()}] ERROR: Firma de webhook inválida o faltante`, signatureCheck);
    // DEBUG TEMPORAL: se devuelve el detalle en la respuesta para diagnosticar
    // por qué la firma real de Zendesk no matchea. Sacar esto una vez resuelto.
    return res.status(401).json({ error: 'Firma de webhook inválida', debug: signatureCheck });
  }

  const { ticket_id, ticket_subject, agent_reply, agent_name } = req.body;

  console.log(`\n[${new Date().toISOString()}] Webhook recibido`);
  console.log(`  Ticket ID : ${ticket_id}`);
  console.log(`  Subject   : ${ticket_subject}`);
  console.log(`  Agente    : ${agent_name}`);
  console.log(`  Reply     : ${agent_reply?.substring(0, 80)}...`);

  // Validar campos requeridos
  if (!ticket_subject || !agent_reply) {
    console.error('  ERROR: Faltan campos requeridos en el payload');
    return res.status(400).json({ error: 'Faltan campos: ticket_subject y agent_reply son requeridos' });
  }

  // Extraer el Intercom Conversation ID del subject
  const conversationId = extractConversationId(ticket_subject);

  if (!conversationId) {
    console.error(`  ERROR: No se pudo extraer el Intercom Conversation ID del subject: "${ticket_subject}"`);
    return res.status(422).json({
      error: 'No se encontró el Intercom Conversation ID en el subject del ticket',
      subject: ticket_subject
    });
  }

  console.log(`  Intercom Conv ID: ${conversationId}`);

  // Formatear el mensaje (incluye atribución al agente de Zendesk)
  const formattedMessage = `💬 <b>Respuesta desde Zendesk</b>${agent_name ? ` (${agent_name})` : ''}:<br><br>${agent_reply}`;

  try {
    const result = await sendIntercomReply(conversationId, formattedMessage);
    console.log(`  ✅ Reply enviado correctamente. Reply ID: ${result.id}`);
    return res.status(200).json({ ok: true, reply_id: result.id, conversation_id: conversationId });
  } catch (err) {
    // Errores conocidos de Intercom: distinguimos por status para dar un mensaje claro
    if (err.status === 404) {
      console.error(`  ❌ Conversación de Intercom no encontrada: ${conversationId}`);
      return res.status(404).json({
        error: 'La conversación de Intercom no existe o ya fue cerrada/eliminada',
        conversation_id: conversationId
      });
    }

    if (err.status === 401) {
      console.error('  ❌ Intercom respondió 401: el INTERCOM_TOKEN puede estar vencido o ser inválido');
      return res.status(401).json({ error: 'Autenticación con Intercom falló: revisar INTERCOM_TOKEN' });
    }

    if (err.status === 504) {
      console.error(`  ❌ ${err.message}`);
      return res.status(504).json({ error: err.message });
    }

    console.error(`  ❌ Error al enviar reply a Intercom: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 Zendesk→Intercom relay corriendo en http://localhost:${PORT}`);
  console.log(`   Endpoint activo: POST http://localhost:${PORT}/zendesk-reply`);
  console.log(`   Health check  : GET  http://localhost:${PORT}/health\n`);
});
