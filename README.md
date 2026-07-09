# zendesk-intercom-relay

Middleware Node.js/Express que reenvía las respuestas públicas de agentes de Zendesk
hacia conversaciones de Intercom, para que lleguen al canal de Slack del cliente
en escalaciones originadas por Fin AI.

## Flujo completo

```
Agente responde en Zendesk
  → Zendesk Trigger dispara webhook
  → POST /zendesk-reply
  → middleware extrae el Intercom Conversation ID del subject del ticket
  → POST /conversations/{id}/reply a la API de Intercom
  → Intercom entrega el mensaje al canal de Slack del cliente
```

El subject del ticket siempre tiene el formato:

```
Escalación Fin: {INTERCOM_CONVERSATION_ID}
```

Ejemplo: `Escalación Fin: 12345678901234`

## Setup

Requiere Node.js 18 o superior (usa `fetch` nativo).

```bash
npm install
cp .env.example .env
```

Completá `.env` con tus credenciales:

| Variable | Descripción |
|---|---|
| `INTERCOM_TOKEN` | Bearer token de la API de Intercom |
| `INTERCOM_ADMIN_ID` | ID numérico del admin que firma los replies |
| `PORT` | Puerto local del servidor (default `3000`) |
| `ZENDESK_WEBHOOK_SECRET` | (Opcional) Secreto para validar la firma del webhook de Zendesk. Si se deja vacío, la validación se salta (modo dev) |

## Correr localmente

```bash
npm start        # producción
npm run dev       # con nodemon (reinicia al guardar cambios)
```

El servidor expone:

- `POST /zendesk-reply` — endpoint principal que recibe el webhook de Zendesk
- `GET /health` — health check

### Probar el webhook sin depender de Zendesk

`test-webhook.js` simula exactamente el payload que envía el Trigger de Zendesk:

```bash
node test-webhook.js 98765432109876
# o
CONVERSATION_ID=98765432109876 node test-webhook.js
# o vía script de npm
npm run test:webhook -- 98765432109876
```

Usá un `conversation_id` real de una conversación de Intercom abierta para
verificar que el reply llega correctamente. Si `ZENDESK_WEBHOOK_SECRET` está
seteado en tu `.env`, el script firma el request automáticamente para poder
probar también la validación de firma end-to-end.

## Payload esperado desde el Trigger de Zendesk

```json
{
  "ticket_id": "12345",
  "ticket_subject": "Escalación Fin: 98765432109876",
  "agent_reply": "<p>Hola, tu consulta fue resuelta.</p>",
  "agent_name": "María García"
}
```

- `ticket_subject` **debe** contener `Escalación Fin: <conversation_id>` — si no
  se encuentra el ID, el endpoint responde `422`.
- `ticket_subject` y `agent_reply` son requeridos — si faltan, responde `400`.

### Respuestas del endpoint

| Status | Motivo |
|---|---|
| `200` | Reply enviado correctamente a Intercom |
| `400` | Faltan `ticket_subject` o `agent_reply` en el payload |
| `401` | Firma de webhook inválida, o Intercom rechazó el token (revisar `INTERCOM_TOKEN`) |
| `404` | La conversación de Intercom no existe |
| `422` | No se pudo extraer el Intercom Conversation ID del subject |
| `504` | Timeout: Intercom no respondió en 10 segundos |
| `500` | Otro error inesperado de la API de Intercom |

## Exponer con ngrok (para configurar el Trigger de Zendesk)

```bash
ngrok http 3000
```

Ngrok te va a dar una URL pública tipo `https://abcd1234.ngrok-free.app`.
La URL que tenés que usar en el Trigger de Zendesk es:

```
https://abcd1234.ngrok-free.app/zendesk-reply
```

> Cada vez que reiniciás ngrok (plan free) la URL cambia — hay que actualizar
> el Trigger en Zendesk con la nueva URL.

## Configurar el Trigger en Zendesk

En Zendesk Admin Center → **Objects and rules** → **Business rules** → **Triggers** → **Add trigger**.

**Nombre:** `Escalación Fin → Intercom relay`

**Conditions (Meet ALL of the following):**

| Campo | Operador | Valor |
|---|---|---|
| Ticket is | — | Updated |
| Comment is | — | Public |
| Current User | Is | (Agent) *(excluye triggers automáticos)* |
| Subject | Contains | `Escalación Fin:` |

> Ajustá según tu setup: si querés limitarlo a un grupo/marca específico, agregá
> esa condición también.

**Actions:**

| Acción | Valor |
|---|---|
| Notify by | Active webhook (creá uno nuevo apuntando a tu URL de `/zendesk-reply`, método `POST`, formato JSON) |
| JSON body | ver abajo |

**Webhook — Create webhook:**

- **Endpoint URL:** `https://<tu-url-publica>/zendesk-reply`
- **Request method:** `POST`
- **Request format:** `JSON`
- **Authentication:** ninguna, o Bearer token si agregás esa capa vos mismo
- Si configuraste `ZENDESK_WEBHOOK_SECRET`, activá la firma de webhooks de
  Zendesk (Webhooks → tu webhook → **Signing Secret**) usando el mismo valor.

**JSON body del trigger action:**

```json
{
  "ticket_id": "{{ticket.id}}",
  "ticket_subject": "{{ticket.title}}",
  "agent_reply": "{{ticket.latest_public_comment_html}}",
  "agent_name": "{{current_user.name}}"
}
```

## Validación de firma del webhook (opcional)

Si seteás `ZENDESK_WEBHOOK_SECRET`, el endpoint valida los headers
`x-zendesk-webhook-signature` y `x-zendesk-webhook-signature-timestamp` que
Zendesk envía cuando el webhook tiene un signing secret configurado. La firma
se calcula como `HMAC-SHA256(secret, timestamp + raw_body)` codificado en
base64. Si no coincide (o falta), el endpoint responde `401`.

Si `ZENDESK_WEBHOOK_SECRET` no está seteado, la validación se salta
completamente (útil para desarrollo local).

## Deploy en Render

1. Subí el repo a GitHub (asegurate de que `.env` esté en `.gitignore` — ya lo está).
2. En Render: **New** → **Web Service** → conectá el repo.
3. Configuración del servicio:
   - **Environment:** `Node`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. En **Environment Variables**, agregá:
   - `INTERCOM_TOKEN`
   - `INTERCOM_ADMIN_ID`
   - `ZENDESK_WEBHOOK_SECRET` (si lo usás)
   - `PORT` no hace falta setearlo — Render lo inyecta automáticamente y el
     código ya usa `process.env.PORT`.
5. Deploy. Render te da una URL pública fija (`https://tu-app.onrender.com`).
6. Actualizá el Trigger de Zendesk para que apunte a
   `https://tu-app.onrender.com/zendesk-reply` en lugar de la URL de ngrok.
7. Verificá con `GET https://tu-app.onrender.com/health`.

## Estructura del proyecto

```
.
├── server.js          # servidor Express + lógica de relay
├── test-webhook.js     # script para simular el webhook de Zendesk
├── package.json
├── .env               # credenciales (no versionado)
├── .env.example       # plantilla de variables de entorno
└── .gitignore
```
