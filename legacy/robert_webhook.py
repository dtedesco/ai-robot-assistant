#!/usr/bin/env python3
"""
Robert RS01 - Webhook Server para Valid Watch
Recebe eventos de portaria e saúda pessoas pelo nome com OpenAI

Formato Valid Watch:
{
  "specVersion": "v1",
  "eventId": "...",
  "eventType": "portaria.visit.entry_approved",
  "occurredAt": "2026-04-10T15:00:00.000Z",
  "channel": "portaria",
  "payload": { ... }
}

HMAC: sha256=<hex> sobre "<timestamp>.<raw_body>"
"""

import asyncio
import hashlib
import hmac
import json
import os
import subprocess
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

from bleak import BleakClient
from openai import OpenAI

# ============= Configuração =============

WEBHOOK_PORT = int(os.environ.get("WEBHOOK_PORT", 8081))
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")

# Tolerância de timestamp (segundos) para evitar replay
TIMESTAMP_TOLERANCE = 300  # 5 minutos

# Robert BLE
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"

# Estado global
ble_client = None
ble_lock = threading.Lock()
openai_client = None
processed_events = set()  # Para deduplicação por eventId

# Protocolo Robert
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def build_packet(action, color=2):
    """Constrói pacote de ação para o Robert"""
    data = bytes([action, action, 8, 0, color, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

# ============= BLE =============

async def ble_connect():
    """Conecta ao Robert via BLE"""
    global ble_client
    try:
        ble_client = BleakClient(ROBERT_BLE_ADDR, timeout=10)
        await ble_client.connect()
        print(f"[BLE] Conectado ao Robert!")
        return True
    except Exception as e:
        print(f"[BLE] Erro: {e}")
        return False

async def ble_send(action, color=2):
    """Envia comando para o Robert"""
    global ble_client
    try:
        if ble_client and ble_client.is_connected:
            packet = build_packet(action, color)
            await ble_client.write_gatt_char(WRITE_UUID, packet, response=False)
            return True
    except Exception as e:
        print(f"[BLE] Erro ao enviar: {e}")
    return False

def ble_send_sync(action, color=2):
    """Envia comando de forma síncrona (para usar em threads)"""
    def run():
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(ble_send(action, color))
        finally:
            loop.close()
    threading.Thread(target=run, daemon=True).start()

# ============= OpenAI =============

def gerar_saudacao(nome, evento_tipo):
    """Gera saudação personalizada com OpenAI"""
    global openai_client

    # Determina se é entrada ou saída
    is_entrada = "entry" in evento_tipo or "approved" in evento_tipo
    is_saida = "exit" in evento_tipo

    if not OPENAI_API_KEY:
        if is_saida:
            return f"Tchau {nome}, até logo!"
        return f"Olá {nome}, bem-vindo!"

    if not openai_client:
        openai_client = OpenAI(api_key=OPENAI_API_KEY)

    try:
        hora = int(time.strftime("%H"))
        if hora < 12:
            periodo = "bom dia"
        elif hora < 18:
            periodo = "boa tarde"
        else:
            periodo = "boa noite"

        if is_saida:
            acao = "saindo"
            padrao = "até logo"
        else:
            acao = "chegando"
            padrao = "bem-vindo"

        prompt = f"""Você é Robert, um robô simpático e carinhoso de uma portaria.
Gere uma saudação CURTA (máximo 12 palavras) para {nome} que está {acao}.
Seja animado e use "{periodo}". Não use emojis.
Responda APENAS com a frase de saudação, nada mais."""

        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=40,
            temperature=0.9
        )
        return response.choices[0].message.content.strip().strip('"')
    except Exception as e:
        print(f"[OpenAI] Erro: {e}")
        if is_saida:
            return f"Tchau {nome}, até logo!"
        return f"Olá {nome}, {padrao}!"

# ============= Fala =============

def falar(texto):
    """Faz o Robert falar usando síntese de voz do macOS"""
    print(f"[Fala] {texto}")

    # Cor roxa = falando
    ble_send_sync(77, 6)

    # Animar enquanto fala
    def animar():
        movimentos = [100, 102, 104, 106, 108, 110]
        i = 0
        # Estima duração: ~0.08s por caractere
        duracao = len(texto) * 0.08
        inicio = time.time()
        while time.time() - inicio < duracao:
            ble_send_sync(movimentos[i % len(movimentos)])
            time.sleep(0.2)
            i += 1
        # Volta para verde (pronto)
        ble_send_sync(77, 3)

    threading.Thread(target=animar, daemon=True).start()

    # Usa say do macOS com voz portuguesa
    subprocess.run(
        ["say", "-v", "Luciana", texto],
        capture_output=True
    )

# ============= Webhook HMAC =============

def verificar_hmac(raw_body: bytes, timestamp: str, signature_header: str, secret: str) -> dict:
    """
    Verifica assinatura HMAC do Valid Watch
    Formato: sha256=<hex>
    Mensagem: <timestamp>.<raw_body>

    Retorna dict com { ok: bool, reason: str }
    """
    # Sem segredo configurado - não valida
    if not secret:
        print("[HMAC] Segredo não configurado - assinatura não verificada")
        return {"ok": True, "reason": "sem segredo configurado"}

    # Extrai hex do header (remove "sha256=" prefix)
    if not signature_header:
        print("[HMAC] Header x-webhook-signature ausente")
        return {"ok": False, "reason": "header x-webhook-signature ausente"}

    signature_header = signature_header.strip()
    if signature_header.lower().startswith("sha256="):
        received_hex = signature_header[7:].strip()
    else:
        received_hex = signature_header

    # Calcula HMAC esperado
    payload = f"{timestamp}.{raw_body.decode('utf-8')}"
    expected_hex = hmac.new(
        secret.encode('utf-8'),
        payload.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    # Comparação segura
    try:
        if hmac.compare_digest(expected_hex.lower(), received_hex.lower()):
            print("[HMAC] Assinatura válida")
            return {"ok": True, "reason": "assinatura válida"}
        else:
            print(f"[HMAC] Assinatura inválida")
            print(f"  esperado: {expected_hex}")
            print(f"  recebido: {received_hex}")
            return {"ok": False, "reason": "assinatura não confere"}
    except Exception as e:
        print(f"[HMAC] Erro: {e}")
        return {"ok": False, "reason": str(e)}

def verificar_timestamp(timestamp_str: str) -> bool:
    """Verifica se timestamp está dentro da janela aceitável"""
    try:
        ts = int(timestamp_str)
        now = int(time.time())
        diff = abs(now - ts)
        return diff <= TIMESTAMP_TOLERANCE
    except ValueError:
        return False

# ============= Processamento de Eventos =============

def extrair_nome_do_payload(payload: dict, event_type: str) -> str | None:
    """
    Extrai nome da pessoa do payload.
    Adapte conforme o formato real do Valid Watch.
    """
    # Tenta vários caminhos possíveis no payload
    paths = [
        # Caminhos comuns
        ("person", "name"),
        ("person", "firstName"),
        ("person", "fullName"),
        ("visitor", "name"),
        ("visitor", "firstName"),
        ("visitante", "nome"),
        ("pessoa", "nome"),
        ("guest", "name"),
        # Campos diretos
        ("name",),
        ("personName",),
        ("visitorName",),
        ("nome",),
        # Nested em visit
        ("visit", "person", "name"),
        ("visit", "visitor", "name"),
        ("visit", "guest", "name"),
    ]

    for path in paths:
        obj = payload
        for key in path:
            if isinstance(obj, dict) and key in obj:
                obj = obj[key]
            else:
                obj = None
                break
        if obj and isinstance(obj, str):
            return obj

    # Log para debug se não encontrar
    print(f"[Payload] Campos disponíveis: {list(payload.keys())}")
    return None

def processar_evento(data: dict) -> bool:
    """Processa evento do Valid Watch"""
    global processed_events

    # Valida envelope
    spec_version = data.get("specVersion")
    event_id = data.get("eventId")
    event_type = data.get("eventType", "")
    channel = data.get("channel", "")
    payload = data.get("payload", {})

    print(f"[Evento] {event_type} (channel={channel}, id={event_id})")

    # Deduplicação
    if event_id in processed_events:
        print(f"[Evento] Duplicado, ignorando: {event_id}")
        return True
    processed_events.add(event_id)

    # Limpa eventos antigos (mantém últimos 1000)
    if len(processed_events) > 1000:
        processed_events.clear()

    # Filtra apenas eventos de portaria relevantes
    eventos_entrada = [
        "portaria.visit.entry_approved",
        "portaria.visit.entry",
        "portaria.visit.check_in",
    ]
    eventos_saida = [
        "portaria.visit.exit_registered",
        "portaria.visit.exit",
        "portaria.visit.auto_exit",
        "portaria.visit.check_out",
    ]

    if event_type not in eventos_entrada + eventos_saida:
        # Evento de teste ou outro tipo
        if event_type == "partner_webhook.ping":
            print("[Evento] Ping de teste recebido!")
            return True
        print(f"[Evento] Tipo ignorado: {event_type}")
        return True

    # Extrai nome
    nome = extrair_nome_do_payload(payload, event_type)

    if not nome:
        print(f"[Evento] Nome não encontrado no payload")
        print(f"[Payload] {json.dumps(payload, indent=2, ensure_ascii=False)}")
        return False

    # Gera saudação e fala
    print(f"[Evento] Pessoa detectada: {nome}")
    saudacao = gerar_saudacao(nome, event_type)
    threading.Thread(target=falar, args=(saudacao,), daemon=True).start()

    return True

# ============= HTTP Handler =============

class WebhookHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silencia logs padrão
        pass

    def send_json(self, status: int, data: dict):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_POST(self):
        # Lê headers
        timestamp = self.headers.get('x-webhook-timestamp', '')
        signature = self.headers.get('x-webhook-signature', '')
        webhook_id = self.headers.get('x-webhook-id', '')

        # Lê corpo
        content_length = int(self.headers.get('Content-Length', 0))
        raw_body = self.rfile.read(content_length)

        print(f"\n[Webhook] POST recebido ({len(raw_body)} bytes)")
        print(f"  x-webhook-timestamp: {timestamp or '(ausente)'}")
        print(f"  x-webhook-signature: {signature[:20] + '...' if signature else '(ausente)'}")
        print(f"  x-webhook-id       : {webhook_id or '(ausente)'}")

        # Verifica timestamp (anti-replay) - apenas loga, não rejeita
        timestamp_ok = False
        if timestamp:
            timestamp_ok = verificar_timestamp(timestamp)
            if not timestamp_ok:
                print(f"  [AVISO] Timestamp fora da janela de {TIMESTAMP_TOLERANCE}s")
        else:
            print("  [AVISO] Timestamp ausente")

        # Verifica HMAC - apenas loga, não rejeita (sempre retorna 200)
        sig_result = verificar_hmac(raw_body, timestamp, signature, WEBHOOK_SECRET)

        # Parse JSON
        try:
            data = json.loads(raw_body.decode('utf-8'))
        except json.JSONDecodeError as e:
            print(f"[Webhook] JSON inválido: {e}")
            self.send_json(400, {"error": "Invalid JSON"})
            return

        # Log do envelope
        print(f"  eventType  : {data.get('eventType', '?')}")
        print(f"  eventId    : {data.get('eventId', '?')}")
        print(f"  channel    : {data.get('channel', '?')}")

        # Sempre responde 200 rapidamente (mesmo com assinatura inválida)
        # Isso evita retentativas infinitas de algumas plataformas
        self.send_json(200, {"received": True, "signatureValid": sig_result.get("ok", False)})

        # Processa em background (apenas se assinatura OK ou sem secret configurado)
        if sig_result.get("ok", False):
            threading.Thread(target=processar_evento, args=(data,), daemon=True).start()
        else:
            print(f"[Webhook] Evento ignorado - assinatura inválida")

    def do_GET(self):
        """Health check endpoint"""
        import datetime
        ble_connected = ble_client.is_connected if ble_client else False
        self.send_json(200, {
            "ok": True,
            "service": "robert-webhook",
            "hint": "envie POST JSON com x-webhook-timestamp e x-webhook-signature",
            "now": datetime.datetime.now().isoformat(),
            "ble_connected": ble_connected,
            "events_processed": len(processed_events)
        })

# ============= Main =============

def main():
    print("=" * 55)
    print("  Robert RS01 - Webhook Server para Valid Watch")
    print("=" * 55)
    print()

    # Verifica configuração
    if not WEBHOOK_SECRET:
        print("[AVISO] WEBHOOK_SECRET não configurado!")
        print("        Assinaturas HMAC não serão validadas.")
        print()

    if not OPENAI_API_KEY:
        print("[AVISO] OPENAI_API_KEY não configurado!")
        print("        Saudações serão genéricas.")
        print()

    # Conecta BLE
    print("[BLE] Conectando ao Robert...")
    loop = asyncio.new_event_loop()
    connected = loop.run_until_complete(ble_connect())
    loop.close()

    if not connected:
        print("[BLE] Continuando sem conexão BLE...")
    print()

    # Inicia servidor
    server = HTTPServer(('0.0.0.0', WEBHOOK_PORT), WebhookHandler)

    print(f"[HTTP] Servidor rodando em http://0.0.0.0:{WEBHOOK_PORT}")
    print()
    print("Configuração para Valid Watch:")
    print(f"  URL: https://<seu-dominio>:{WEBHOOK_PORT}/")
    print(f"  Canal: portaria")
    print(f"  Eventos: entry_approved, exit_registered")
    print()
    print("Aguardando eventos...")
    print("-" * 55)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[HTTP] Servidor encerrado")

if __name__ == '__main__':
    main()
