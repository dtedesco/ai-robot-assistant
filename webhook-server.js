#!/usr/bin/env node
/**
 * Receptor de Webhooks - Valid Watch
 * Valida assinatura HMAC-SHA256 e imprime o evento formatado.
 *
 * Uso:
 *   WEBHOOK_SECRET="seu-segredo-aqui" node webhook-server.js
 *
 * Porta padrao: 8080 (altere com PORT=3000)
 */

const http = require('node:http');
const { createHmac, timingSafeEqual } = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const SECRET = process.env.WEBHOOK_SECRET || '';
// Janela de tolerancia para o timestamp (segundos). Recomendacao da doc: +/- 5 min.
const CLOCK_SKEW_SEC = 300;

// Dedup em memoria (eventId ja processados) - ao menos uma entrega / idempotencia.
const seenEvents = new Set();

function parseSignatureHeader(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  const prefix = 'sha256=';
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  return trimmed.slice(prefix.length).trim();
}

function verifySignature(secret, rawBody, timestampSec, signatureHeader) {
  const receivedHex = parseSignatureHeader(signatureHeader);
  if (!receivedHex) return { ok: false, reason: 'cabecalho x-webhook-signature ausente/invalido' };

  const payload = `${timestampSec}.${rawBody}`;
  const expectedHex = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

  let left, right;
  try {
    left = Buffer.from(expectedHex, 'hex');
    right = Buffer.from(receivedHex, 'hex');
  } catch {
    return { ok: false, reason: 'hex invalido' };
  }
  if (left.length !== right.length) return { ok: false, reason: 'tamanho diferente', expectedHex, receivedHex };
  const ok = timingSafeEqual(left, right);
  return { ok, reason: ok ? 'assinatura valida' : 'assinatura nao confere', expectedHex, receivedHex };
}

function color(code, s) { return `\x1b[${code}m${s}\x1b[0m`; }
const green = (s) => color('32', s);
const red = (s) => color('31', s);
const yellow = (s) => color('33', s);
const cyan = (s) => color('36', s);
const bold = (s) => color('1', s);

function logSeparator() {
  console.log(color('90', '─'.repeat(72)));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const now = new Date().toISOString();

  // Healthcheck simples
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      service: 'valid-watch-webhook-receiver',
      hint: 'envie POST JSON com x-webhook-timestamp e x-webhook-signature',
      now,
    }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405); return res.end('method not allowed');
  }

  let rawBody = '';
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    res.writeHead(400); return res.end('erro lendo corpo');
  }

  const hdrSig = req.headers['x-webhook-signature'];
  const hdrTs = req.headers['x-webhook-timestamp'];
  const hdrId = req.headers['x-webhook-id'];

  logSeparator();
  console.log(bold(cyan(`[${now}] POST ${req.url}  (${rawBody.length} bytes)`)));
  console.log(bold('Cabecalhos relevantes:'));
  console.log('  x-webhook-timestamp:', hdrTs || red('(ausente)'));
  console.log('  x-webhook-signature:', hdrSig || red('(ausente)'));
  console.log('  x-webhook-id       :', hdrId || yellow('(ausente)'));

  // Verifica janela de tempo
  let timestampOk = false;
  if (hdrTs && /^\d+$/.test(String(hdrTs))) {
    const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(hdrTs));
    timestampOk = skew <= CLOCK_SKEW_SEC;
    console.log('  skew(segundos)     :', timestampOk ? green(skew) : red(`${skew}  (fora de +/- ${CLOCK_SKEW_SEC}s)`));
  } else {
    console.log('  skew(segundos)     :', red('timestamp invalido'));
  }

  // Verifica assinatura
  let sigResult = { ok: false, reason: 'sem segredo configurado' };
  if (!SECRET) {
    console.log(yellow('AVISO: WEBHOOK_SECRET nao definido - nao foi possivel verificar a assinatura.'));
  } else {
    sigResult = verifySignature(SECRET, rawBody, String(hdrTs || ''), String(hdrSig || ''));
    console.log('  assinatura         :', sigResult.ok ? green(sigResult.reason) : red(sigResult.reason));
    if (!sigResult.ok && sigResult.expectedHex) {
      console.log('    esperado :', sigResult.expectedHex);
      console.log('    recebido :', sigResult.receivedHex);
    }
  }

  // Tenta parsear JSON
  let parsed = null;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    console.log(red('corpo nao e JSON valido'));
  }

  if (parsed) {
    console.log(bold('Envelope:'));
    console.log('  specVersion :', parsed.specVersion);
    console.log('  eventId     :', parsed.eventId);
    console.log('  eventType   :', parsed.eventType);
    console.log('  occurredAt  :', parsed.occurredAt);
    console.log('  channel     :', parsed.channel);
    console.log(bold('Payload:'));
    console.log(JSON.stringify(parsed.payload, null, 2).split('\n').map(l => '  ' + l).join('\n'));

    // Dedup idempotente
    if (parsed.eventId) {
      if (seenEvents.has(parsed.eventId)) {
        console.log(yellow(`(duplicado) eventId ${parsed.eventId} ja processado - ignorando efeitos colaterais.`));
      } else {
        seenEvents.add(parsed.eventId);
      }
    }
  }

  // Politica: responder 2xx rapido. Se quiser testar retentativa, troque para 500.
  // Aqui respondemos 200 sempre que o corpo for lido, mesmo com assinatura invalida,
  // porque algumas plataformas tratam 401/403 como erro permanente e param retentativas.
  // Se preferir rejeitar invalidos, troque o bloco abaixo.
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ received: true, signatureValid: sigResult.ok }));
});

server.listen(PORT, () => {
  console.log(bold(green(`Valid Watch webhook receiver escutando em http://0.0.0.0:${PORT}`)));
  if (!SECRET) {
    console.log(yellow('Defina WEBHOOK_SECRET para validar assinatura HMAC:'));
    console.log(yellow('  WEBHOOK_SECRET="seu-segredo-de-pelo-menos-16-chars" node webhook-server.js'));
  } else {
    console.log(`segredo configurado (${SECRET.length} chars).`);
  }
  console.log(`GET  /  -> healthcheck`);
  console.log(`POST /  -> recebe webhook`);
});
