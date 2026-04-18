#!/usr/bin/env python3
"""
Sofia - OpenAI Realtime API
Servidor WebSocket proxy para conversa instantânea
"""

import asyncio
import base64
import json
import os
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import websockets
from bleak import BleakClient

import hashlib
import hmac as hmac_module

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
CONTEXT_FILE = "/Users/diogo.tedesco/Projects/robot/sofia_context.json"
WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "")

# Armazenamento de eventos webhook
webhook_events = []
pending_visitors = []  # Fila de visitantes para Sofia cumprimentar
MAX_EVENTS = 50
active_openai_ws = None  # Referência ao WebSocket do OpenAI ativo

# Controle de cooldown para evitar spam
greeted_recently = {}  # {nome: timestamp}
GREETING_COOLDOWN = 30  # Segundos entre saudações para mesma pessoa

# Contexto padrão
DEFAULT_CONTEXT = {
    "nome": "Sofia",
    "personalidade": "uma robô amiga muito simpática e fofa",
    "instrucoes": "Seja divertida, animada e carinhosa. Respostas curtas e naturais.",
    "idioma": "português brasileiro",
    "extras": ""
}

def load_context():
    """Carrega contexto do arquivo JSON"""
    try:
        with open(CONTEXT_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except:
        return DEFAULT_CONTEXT.copy()

def save_context(ctx):
    """Salva contexto no arquivo JSON"""
    with open(CONTEXT_FILE, 'w', encoding='utf-8') as f:
        json.dump(ctx, f, ensure_ascii=False, indent=2)

def build_instructions():
    """Constrói instruções a partir do contexto"""
    ctx = load_context()
    instrucoes = f"Você é {ctx['nome']}, {ctx['personalidade']}. "
    instrucoes += f"SEMPRE fale em {ctx['idioma']}. "
    instrucoes += ctx['instrucoes']
    if ctx.get('extras'):
        instrucoes += f" {ctx['extras']}"
    instrucoes += " NUNCA fale em inglês."
    return instrucoes

def extrair_nome_do_payload(payload: dict) -> str | None:
    """Extrai nome da pessoa do payload do webhook"""
    paths = [
        # Valid Watch camera_sighting
        ("identity", "displayName"),
        ("identity", "name"),
        # Portaria/visita
        ("person", "name"), ("person", "firstName"), ("person", "fullName"),
        ("visitor", "name"), ("visitor", "firstName"),
        ("visitante", "nome"), ("pessoa", "nome"), ("guest", "name"),
        ("name",), ("personName",), ("visitorName",), ("nome",),
        ("visit", "person", "name"), ("visit", "visitor", "name"),
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
    return None

# Armazena último payload raw para debug
last_raw_payload = {}

def processar_webhook(data: dict) -> dict:
    """Processa evento do Valid Watch e retorna info do visitante"""
    global webhook_events, pending_visitors, last_raw_payload, greeted_recently

    event_type = data.get("eventType", "")
    event_id = data.get("eventId", "")
    payload = data.get("payload", {})
    occurred_at = data.get("occurredAt", "")

    # Salva payload raw para debug
    last_raw_payload = {"event_type": event_type, "payload": payload, "full": data}

    # Verifica se é pessoa identificada (ignora "unknown" e "unmatched")
    identity_kind = payload.get("identity", {}).get("kind", "unknown")
    if identity_kind in ["unknown", "unmatched"]:
        return {"id": event_id, "ignored": True, "reason": identity_kind}

    # Extrai nome
    nome = extrair_nome_do_payload(payload)
    if not nome:
        return {"id": event_id, "ignored": True, "reason": "no_name"}

    # Verifica cooldown (evita cumprimentar mesma pessoa várias vezes)
    last_greeted = greeted_recently.get(nome, 0)
    if time.time() - last_greeted < GREETING_COOLDOWN:
        print(f"[Webhook] {nome} - Cooldown ativo, ignorando")
        return {"id": event_id, "nome": nome, "ignored": True, "reason": "cooldown"}
    greeted_recently[nome] = time.time()

    # Determina tipo de evento
    is_entrada = "entry" in event_type or "approved" in event_type or "check_in" in event_type or "sighting" in event_type
    is_saida = "exit" in event_type or "check_out" in event_type

    # Cria registro do evento
    evento = {
        "id": event_id,
        "type": event_type,
        "nome": nome,
        "is_entrada": is_entrada,
        "is_saida": is_saida,
        "occurred_at": occurred_at,
        "timestamp": time.strftime("%H:%M:%S")
    }

    # Adiciona ao log
    webhook_events.insert(0, evento)
    if len(webhook_events) > MAX_EVENTS:
        webhook_events = webhook_events[:MAX_EVENTS]

    # Adiciona visitante à fila para Sofia cumprimentar
    pending_visitors.append({
        "nome": nome,
        "is_entrada": is_entrada,
        "is_saida": is_saida
    })
    print(f"[Webhook] {nome} adicionado à fila de saudação")

    return evento
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
HTTP_PORT = 8080
WS_PORT = 9000

# BLE
ble = None
color = 2
speaking = False
ble_lock = threading.Lock()
ble_reconnecting = False

HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

# Intervalo de reconexão BLE (segundos)
BLE_RECONNECT_INTERVAL = 5

def packet(action, c):
    data = bytes([action, action, 8, 0, c, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

async def ble_connect_async():
    global ble
    try:
        if ble and ble.is_connected:
            return True
        ble = BleakClient(ROBERT_BLE_ADDR, timeout=10)
        await ble.connect()
        print("[BLE] Conectado!")
        return True
    except Exception as e:
        print(f"[BLE] Erro: {e}")
        return False

async def ble_reconnect_loop():
    """Loop que tenta reconectar BLE automaticamente"""
    global ble, ble_reconnecting
    ble_reconnecting = True
    while True:
        try:
            if ble is None or not ble.is_connected:
                print("[BLE] Tentando reconectar...")
                connected = await ble_connect_async()
                if connected:
                    set_color_sync(3)  # Verde quando conecta
            await asyncio.sleep(BLE_RECONNECT_INTERVAL)
        except Exception as e:
            print(f"[BLE] Erro no loop: {e}")
            await asyncio.sleep(BLE_RECONNECT_INTERVAL)

def start_ble_reconnect_thread():
    """Inicia thread de reconexão BLE"""
    def run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(ble_reconnect_loop())
    threading.Thread(target=run, daemon=True).start()

async def ble_send_async(action):
    global ble, color
    try:
        if ble and ble.is_connected:
            await ble.write_gatt_char(WRITE_UUID, packet(action, color), response=False)
    except:
        pass

def set_color_thread(c):
    """Executa set_color em thread separada"""
    global color
    color = c
    def run():
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(ble_send_async(77))
        finally:
            loop.close()
    threading.Thread(target=run, daemon=True).start()

def set_color_sync(c):
    set_color_thread(c)

# Timeout de sessão (segundos) - mata sessão se ficar inativo
SESSION_TIMEOUT = 15  # 15 segundos

# WebSocket handler - proxy para OpenAI
async def handle_client(websocket):
    global speaking, color, active_openai_ws, pending_visitors
    print("Cliente conectado")

    openai_ws = None
    last_activity = time.time()

    try:
        # Conectar ao OpenAI Realtime API
        url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17"
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "OpenAI-Beta": "realtime=v1"
        }

        openai_ws = await websockets.connect(url, additional_headers=headers)
        active_openai_ws = openai_ws  # Salva referência global
        print("Conectado ao OpenAI Realtime")

        # Configurar sessão com contexto customizável
        instructions = build_instructions()
        print(f"[OpenAI] Instruções: {instructions[:100]}...")
        await openai_ws.send(json.dumps({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": instructions,
                "voice": "shimmer",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "input_audio_transcription": {"model": "whisper-1"},
                "turn_detection": {
                    "type": "server_vad",
                    "threshold": 0.6,
                    "prefix_padding_ms": 300,
                    "silence_duration_ms": 800
                }
            }
        }))

        # Cor verde = ouvindo
        set_color_sync(3)

        async def forward_to_openai():
            """Recebe do browser, envia pro OpenAI"""
            nonlocal last_activity
            try:
                async for message in websocket:
                    data = json.loads(message)
                    if data.get("type") == "audio":
                        last_activity = time.time()
                        await openai_ws.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": data["audio"]
                        }))
                    elif data.get("type") == "reset":
                        # Cliente pediu reset manual
                        print("Reset de sessão solicitado")
                        raise Exception("session_reset")
            except websockets.exceptions.ConnectionClosed:
                pass

        async def forward_to_browser():
            """Recebe do OpenAI, envia pro browser"""
            nonlocal last_activity
            global speaking
            try:
                async for message in openai_ws:
                    data = json.loads(message)
                    msg_type = data.get("type", "")
                    last_activity = time.time()

                    # Debug
                    if msg_type not in ["response.audio.delta", "input_audio_buffer.speech_started"]:
                        print(f"OpenAI: {msg_type}")

                    if msg_type == "session.created":
                        await websocket.send(json.dumps({"type": "ready"}))

                    elif msg_type == "input_audio_buffer.speech_started":
                        set_color_sync(3)  # Verde = ouvindo
                        await websocket.send(json.dumps({"type": "listening"}))

                    elif msg_type == "input_audio_buffer.speech_stopped":
                        set_color_sync(4)  # Amarelo = processando
                        await websocket.send(json.dumps({"type": "thinking"}))

                    elif msg_type == "response.audio.delta":
                        if not speaking:
                            speaking = True
                            set_color_sync(6)  # Roxo = falando
                            # Limpar buffer de entrada para evitar eco
                            await openai_ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                            # Iniciar animação
                            threading.Thread(target=animate_robot, daemon=True).start()

                        await websocket.send(json.dumps({
                            "type": "audio",
                            "audio": data.get("delta", "")
                        }))

                    elif msg_type == "response.audio_transcript.delta":
                        await websocket.send(json.dumps({
                            "type": "transcript",
                            "text": data.get("delta", "")
                        }))

                    elif msg_type == "response.audio.done":
                        speaking = False
                        # Limpar buffer uma vez
                        await openai_ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                        set_color_sync(3)  # Verde = ouvindo
                        await websocket.send(json.dumps({"type": "done"}))

                    elif msg_type == "conversation.item.input_audio_transcription.completed":
                        await websocket.send(json.dumps({
                            "type": "user_transcript",
                            "text": data.get("transcript", "")
                        }))

                    elif msg_type == "error":
                        print(f"OpenAI erro: {data}")
                        await websocket.send(json.dumps({"type": "error", "message": str(data)}))

            except websockets.exceptions.ConnectionClosed:
                pass

        async def check_timeout():
            """Verifica timeout e mata sessão se inativo"""
            nonlocal last_activity
            while True:
                await asyncio.sleep(5)  # Checa a cada 5s
                idle_time = time.time() - last_activity
                if idle_time > SESSION_TIMEOUT:
                    print(f"Sessão inativa por {int(idle_time)}s - reiniciando...")
                    await websocket.send(json.dumps({"type": "session_timeout"}))
                    raise Exception("session_timeout")

        async def check_visitors():
            """Verifica visitantes pendentes e injeta na conversa"""
            global pending_visitors
            while True:
                await asyncio.sleep(2)  # Checa a cada 2s
                if pending_visitors and not speaking:
                    visitor = pending_visitors.pop(0)
                    nome = visitor.get("nome")
                    is_saida = visitor.get("is_saida", False)

                    # Monta mensagem para Sofia
                    if nome:
                        if is_saida:
                            msg = f"[SISTEMA: {nome} está saindo. Diga tchau de forma carinhosa!]"
                        else:
                            msg = f"[SISTEMA: {nome} acabou de chegar! Cumprimente-o pelo nome de forma animada e simpática!]"
                    else:
                        if is_saida:
                            msg = "[SISTEMA: Alguém está saindo. Dê um tchau simpático!]"
                        else:
                            msg = "[SISTEMA: Alguém chegou! Dê um olá simpático e bem-vindo!]"

                    print(f"[Sofia] Injetando: {msg}")

                    # Envia para OpenAI como mensagem do sistema
                    await openai_ws.send(json.dumps({
                        "type": "conversation.item.create",
                        "item": {
                            "type": "message",
                            "role": "user",
                            "content": [{"type": "input_text", "text": msg}]
                        }
                    }))
                    # Solicita resposta
                    await openai_ws.send(json.dumps({"type": "response.create"}))

        # Rodar todos em paralelo
        await asyncio.gather(
            forward_to_openai(),
            forward_to_browser(),
            check_timeout(),
            check_visitors()
        )

    except Exception as e:
        print(f"Erro: {e}")
        import traceback
        traceback.print_exc()
    finally:
        speaking = False
        active_openai_ws = None
        if openai_ws:
            await openai_ws.close()
        print("Cliente desconectado")

def animate_robot():
    """Anima enquanto fala - braços gesticulando, pernas ocasionais"""
    global speaking
    # Mais braços (gesticulando), pernas só de vez em quando
    # Braços: 100-110, Pernas: 200-210
    moves = [
        100, 102, 104,      # Braços gesticulando
        200,                # Uma perninha
        106, 108, 110,      # Mais braços
        102, 100, 104,      # Continua braços
        202,                # Outra perninha
        108, 106, 110,      # Braços
    ]
    i = 0
    while speaking:
        with ble_lock:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(ble_send_async(moves[i % len(moves)]))
            finally:
                loop.close()
        time.sleep(0.18)  # Ritmo natural de fala
        i += 1

HTML = '''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sofia Realtime</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.c{text-align:center;padding:20px;max-width:450px}
h1{font-size:2.5em;margin-bottom:5px}
.sub{opacity:0.6;margin-bottom:25px;font-size:0.9em}
#face{width:180px;height:180px;background:#fff;border-radius:50%;margin:20px auto;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .3s}
#face.listen{background:#4CAF50;box-shadow:0 0 0 15px rgba(76,175,80,.3),0 0 40px rgba(76,175,80,.5)}
#face.think{background:#FFC107;box-shadow:0 0 0 15px rgba(255,193,7,.3)}
#face.speak{background:#9C27B0;box-shadow:0 0 0 15px rgba(156,39,176,.3);animation:pulse .3s infinite}
#face.muted{background:#607D8B;box-shadow:0 0 0 15px rgba(96,125,139,.3)}
#face.error{background:#f44336}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.02)}}
.eyes{display:flex;gap:30px}
.eye{width:25px;height:25px;background:#333;border-radius:50%;transition:.3s}
#face.listen .eye,#face.think .eye,#face.speak .eye,#face.muted .eye{background:#fff}
#status{font-size:1.3em;margin:20px 0;min-height:30px}
#box{background:rgba(255,255,255,.08);backdrop-filter:blur(10px);padding:20px;border-radius:15px;min-height:100px}
.you{color:#FFE082;min-height:24px}
.rob{color:#B2FF59;margin-top:10px;min-height:24px}
button{margin-top:25px;padding:18px 50px;font-size:1.2em;border:none;border-radius:35px;cursor:pointer;font-weight:600;transition:.2s}
button:hover{transform:scale(1.05)}
#btn{background:linear-gradient(135deg,#4CAF50,#45a049);color:#fff;box-shadow:0 4px 15px rgba(76,175,80,.4)}
#btn.on{background:linear-gradient(135deg,#f44336,#d32f2f);box-shadow:0 4px 15px rgba(244,67,54,.4)}
.volume-container{margin:15px 0;display:flex;align-items:center;justify-content:center;gap:10px}
.volume-container label{font-size:0.9em;opacity:0.8}
.volume-container input[type=range]{width:150px;cursor:pointer}
.volume-value{min-width:40px;font-size:0.9em}
.mic-toggle{margin-top:10px;padding:10px 20px;font-size:0.9em;border-radius:20px;background:#607D8B;color:#fff;border:none;cursor:pointer}
.mic-toggle.off{background:#f44336}
</style>
</head>
<body>
<div style="display:flex;min-height:100vh;padding:20px;gap:20px;max-width:1200px;margin:0 auto">
<!-- ESQUERDA: Visitantes -->
<div style="width:280px;flex-shrink:0;background:rgba(255,255,255,0.08);backdrop-filter:blur(10px);border-radius:15px;padding:15px;display:flex;flex-direction:column">
    <div style="font-weight:bold;font-size:1.1em;margin-bottom:10px">👥 Visitantes</div>
    <div id="visitorList" style="flex:1;overflow-y:auto;font-size:0.85em"></div>
    <div style="border-top:1px solid rgba(255,255,255,0.2);margin-top:10px;padding-top:10px">
        <div style="font-size:0.75em;opacity:0.7;margin-bottom:5px">🔗 URL Webhook:</div>
        <input type="text" id="webhookUrl" style="width:100%;padding:5px;border-radius:5px;border:none;background:rgba(0,0,0,0.3);color:#fff;font-size:0.65em" value="https://homoeomorphous-ena-micrologic.ngrok-free.dev">
        <div style="font-size:0.75em;opacity:0.7;margin:5px 0 3px">🔑 Secret:</div>
        <input type="text" id="webhookSecret" readonly style="width:100%;padding:5px;border-radius:5px;border:none;background:rgba(0,0,0,0.3);color:#fff;font-size:0.6em" value="${WEBHOOK_SECRET}">
        <button onclick="copyConfig()" style="margin-top:8px;padding:5px;border:none;border-radius:5px;background:#4CAF50;color:#fff;cursor:pointer;font-size:0.75em;width:100%">📋 Copiar</button>
    </div>
</div>
<!-- DIREITA: Sofia -->
<div class="c" style="flex:1">
<h1>Sofia</h1>
<p class="sub">OpenAI Realtime - Conversa Instantânea</p>
<div id="ble" onclick="conectarBle()" style="cursor:pointer;padding:8px 16px;border-radius:20px;background:#f44336;display:inline-block;margin-bottom:10px;font-size:0.9em">🔴 BLE Desconectado</div>
<div id="face"><div class="eyes"><div class="eye"></div><div class="eye"></div></div></div>
<div id="status">Clique para começar</div>
<div class="volume-container">
    <label>🔊 Volume:</label>
    <input type="range" id="volume" min="0" max="200" value="100" oninput="setVolume(this.value)">
    <span class="volume-value" id="volVal">100%</span>
</div>
<div class="volume-container">
    <label>🎤 Mic:</label>
    <input type="range" id="micGain" min="0" max="200" value="100" oninput="setMicGain(this.value)">
    <span class="volume-value" id="micVal">100%</span>
</div>
<button class="mic-toggle" id="micToggle" onclick="toggleMic()">🎤 Mic ON</button>
<button class="mic-toggle" id="resetBtn" onclick="resetSession()" style="margin-left:10px;background:#FF9800">🔄 Reset</button>
<button class="mic-toggle" id="ctxBtn" onclick="toggleContext()" style="margin-left:10px;background:#2196F3">⚙️ Contexto</button>
<div id="contextPanel" style="display:none;margin-top:15px;text-align:left;background:rgba(255,255,255,0.1);padding:15px;border-radius:10px">
    <div style="margin-bottom:10px">
        <label style="font-size:0.85em;opacity:0.8">Nome:</label><br>
        <input type="text" id="ctxNome" style="width:100%;padding:8px;border-radius:5px;border:none;background:rgba(255,255,255,0.2);color:#fff" placeholder="Sofia">
    </div>
    <div style="margin-bottom:10px">
        <label style="font-size:0.85em;opacity:0.8">Personalidade:</label><br>
        <input type="text" id="ctxPersonalidade" style="width:100%;padding:8px;border-radius:5px;border:none;background:rgba(255,255,255,0.2);color:#fff" placeholder="uma robô amiga muito simpática">
    </div>
    <div style="margin-bottom:10px">
        <label style="font-size:0.85em;opacity:0.8">Instruções:</label><br>
        <textarea id="ctxInstrucoes" rows="2" style="width:100%;padding:8px;border-radius:5px;border:none;background:rgba(255,255,255,0.2);color:#fff;resize:vertical" placeholder="Seja divertida e carinhosa..."></textarea>
    </div>
    <div style="margin-bottom:10px">
        <label style="font-size:0.85em;opacity:0.8">Extras (contexto adicional):</label><br>
        <textarea id="ctxExtras" rows="3" style="width:100%;padding:8px;border-radius:5px;border:none;background:rgba(255,255,255,0.2);color:#fff;resize:vertical" placeholder="Ex: Você está na recepção da empresa X. Cumprimente visitantes..."></textarea>
    </div>
    <button onclick="saveContext()" style="width:100%;padding:10px;border:none;border-radius:5px;background:#4CAF50;color:#fff;cursor:pointer;font-weight:bold">💾 Salvar e Aplicar</button>
</div>
<div id="box">
<div class="you" id="you"></div>
<div class="rob" id="rob"></div>
</div>
<button id="btn" onclick="toggle()">Começar</button>
</div>
</div>

<script>
let ws = null;
let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let isActive = false;
let audioQueue = [];
let isPlaying = false;
let isSpeaking = false;  // Bloqueia mic enquanto fala
let micMuted = false;    // Mic manualmente mutado
let gainNode = null;     // Controle de volume de saída
let micGainNode = null;  // Controle de ganho do mic
let volumeLevel = 1.0;
let micGainLevel = 1.0;
let micLocked = false;   // Trava anti-eco
let lastSpeakEnd = 0;    // Timestamp de quando parou de falar
const ECHO_GUARD_MS = 2000; // Tempo de guarda anti-eco (2 segundos)

function setVolume(val) {
    volumeLevel = val / 100;
    document.getElementById('volVal').textContent = val + '%';
    if (gainNode) gainNode.gain.value = volumeLevel;
}

function setMicGain(val) {
    micGainLevel = val / 100;
    document.getElementById('micVal').textContent = val + '%';
    if (micGainNode) micGainNode.gain.value = micGainLevel;
}

function toggleMic() {
    micMuted = !micMuted;
    const btn = document.getElementById('micToggle');
    if (micMuted) {
        btn.textContent = '🎤 Mic OFF';
        btn.classList.add('off');
        if (micGainNode) micGainNode.gain.value = 0;
    } else {
        btn.textContent = '🎤 Mic ON';
        btn.classList.remove('off');
        if (micGainNode) micGainNode.gain.value = micGainLevel;
    }
}

function resetSession() {
    console.log('Reset manual solicitado');
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'reset' }));
    }
    // Reconecta
    stop();
    setTimeout(() => start(), 500);
}

function toggleContext() {
    const panel = document.getElementById('contextPanel');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        loadContext();
    } else {
        panel.style.display = 'none';
    }
}

async function loadContext() {
    try {
        const r = await fetch('/context');
        const ctx = await r.json();
        document.getElementById('ctxNome').value = ctx.nome || '';
        document.getElementById('ctxPersonalidade').value = ctx.personalidade || '';
        document.getElementById('ctxInstrucoes').value = ctx.instrucoes || '';
        document.getElementById('ctxExtras').value = ctx.extras || '';
    } catch(e) {
        console.error('Erro ao carregar contexto:', e);
    }
}

async function saveContext() {
    const ctx = {
        nome: document.getElementById('ctxNome').value,
        personalidade: document.getElementById('ctxPersonalidade').value,
        instrucoes: document.getElementById('ctxInstrucoes').value,
        idioma: 'português brasileiro',
        extras: document.getElementById('ctxExtras').value
    };
    try {
        const r = await fetch('/context', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(ctx)
        });
        const d = await r.json();
        if (d.ok) {
            alert('Contexto salvo! Clique em Reset para aplicar.');
            document.getElementById('contextPanel').style.display = 'none';
        }
    } catch(e) {
        alert('Erro ao salvar: ' + e);
    }
}

async function toggle() {
    if (isActive) {
        stop();
    } else {
        await start();
    }
}

async function start() {
    try {
        isActive = true;
        document.getElementById('btn').textContent = 'Parar';
        document.getElementById('btn').classList.add('on');
        setUI('think', 'Conectando...');

        // Conectar WebSocket ao nosso servidor proxy
        ws = new WebSocket('ws://localhost:9000');

        ws.onopen = async () => {
            console.log('WS conectado');
        };

        ws.onmessage = async (e) => {
            const msg = JSON.parse(e.data);

            switch(msg.type) {
                case 'ready':
                    console.log('OpenAI pronto');
                    await startAudio();
                    setUI('listen', 'Fale algo...');
                    break;

                case 'listening':
                    setUI('listen', 'Ouvindo...');
                    break;

                case 'thinking':
                    setUI('think', 'Pensando...');
                    break;

                case 'audio':
                    if (!isSpeaking) {
                        isSpeaking = true;
                        micLocked = true;  // Trava mic imediatamente
                        // Limpa qualquer áudio pendente
                        audioQueue = [];
                    }
                    queueAudio(msg.audio);
                    setUI('speak', 'Falando...');
                    break;

                case 'transcript':
                    document.getElementById('rob').textContent += msg.text;
                    break;

                case 'user_transcript':
                    document.getElementById('you').textContent = 'Você: ' + msg.text;
                    document.getElementById('rob').textContent = 'Sofia: ';
                    break;

                case 'done':
                    // Marca timestamp de fim da fala
                    lastSpeakEnd = Date.now();
                    isSpeaking = false;

                    // Mostra estado de espera anti-eco
                    setUI('muted', 'Aguardando (anti-eco)...');

                    // Libera mic após período de guarda
                    setTimeout(() => {
                        micLocked = false;
                        setUI('listen', 'Ouvindo...');
                        console.log('Mic liberado após anti-eco');
                    }, ECHO_GUARD_MS);
                    break;

                case 'error':
                    console.error('Erro:', msg.message);
                    setUI('error', 'Erro - tente novamente');
                    break;

                case 'session_timeout':
                    console.log('Sessão expirou - limpando contexto...');
                    setUI('think', 'Limpando contexto...');
                    // Limpa transcripts
                    document.getElementById('you').textContent = '';
                    document.getElementById('rob').textContent = '';
                    stop();
                    // Aguarda mais tempo para garantir limpeza
                    setTimeout(() => {
                        console.log('Iniciando nova sessão limpa');
                        start();
                    }, 1500);
                    break;
            }
        };

        ws.onerror = (e) => {
            console.error('WS erro:', e);
            setUI('error', 'Erro de conexão');
        };

        ws.onclose = () => {
            console.log('WS fechado');
            if (isActive) stop();
        };

    } catch (e) {
        console.error('Erro:', e);
        setUI('error', 'Erro: ' + e.message);
        stop();
    }
}

async function startAudio() {
    // Criar AudioContext com sample rate 24000 (exigido pela OpenAI)
    audioCtx = new AudioContext({ sampleRate: 24000 });

    // Criar GainNode para controle de volume de saída
    gainNode = audioCtx.createGain();
    gainNode.gain.value = volumeLevel;
    gainNode.connect(audioCtx.destination);

    // Capturar microfone
    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            sampleRate: 24000,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });

    const source = audioCtx.createMediaStreamSource(mediaStream);

    // Criar GainNode para controle de ganho do mic
    micGainNode = audioCtx.createGain();
    micGainNode.gain.value = micMuted ? 0 : micGainLevel;
    source.connect(micGainNode);

    // Usar ScriptProcessor para capturar áudio
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
        // Não envia se WebSocket não pronto ou mic bloqueado
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (isSpeaking || micMuted || micLocked) return;

        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);

        for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
        ws.send(JSON.stringify({ type: 'audio', audio: base64 }));
    };

    micGainNode.connect(processor);
    processor.connect(audioCtx.destination);
}

function queueAudio(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    const pcm16 = new Int16Array(bytes.buffer);
    audioQueue.push(pcm16);

    if (!isPlaying) {
        playQueue();
    }
}

async function playQueue() {
    if (!audioCtx || audioQueue.length === 0) {
        isPlaying = false;
        return;
    }

    isPlaying = true;

    while (audioQueue.length > 0) {
        const pcm16 = audioQueue.shift();
        const float32 = new Float32Array(pcm16.length);

        for (let i = 0; i < pcm16.length; i++) {
            float32[i] = pcm16[i] / 32768.0;
        }

        const buffer = audioCtx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        // Usa gainNode para controle de volume
        source.connect(gainNode);
        source.start();

        // Esperar o buffer tocar
        await new Promise(r => setTimeout(r, (float32.length / 24000) * 1000 * 0.9));
    }

    isPlaying = false;
}

function stop() {
    isActive = false;
    document.getElementById('btn').textContent = 'Começar';
    document.getElementById('btn').classList.remove('on');

    if (ws) { ws.close(); ws = null; }
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }

    gainNode = null;
    micGainNode = null;
    audioQueue = [];
    isPlaying = false;
    isSpeaking = false;
    document.getElementById('you').textContent = '';
    document.getElementById('rob').textContent = '';
    setUI('', 'Clique para começar');
}

function setUI(cls, txt) {
    document.getElementById('face').className = cls;
    document.getElementById('status').textContent = txt;
}

// Verificar status BLE periodicamente (reconexão é automática no servidor)
async function checkBleStatus() {
    try {
        const r = await fetch('/ble');
        const d = await r.json();
        const el = document.getElementById('ble');
        if (d.ok) {
            el.textContent = '🟢 BLE Conectado';
            el.style.background = '#4CAF50';
        } else {
            el.textContent = '🟡 BLE Reconectando...';
            el.style.background = '#FFC107';
        }
    } catch(e) {
        document.getElementById('ble').textContent = '🔴 BLE Erro';
        document.getElementById('ble').style.background = '#f44336';
    }
}

// Verificar BLE a cada 3 segundos
setInterval(checkBleStatus, 3000);

// ========== Valid Watch ==========
let watchVisible = true;

function copyConfig() {
    const url = document.getElementById('webhookUrl').value;
    const secret = document.getElementById('webhookSecret').value;
    const text = `URL: ${url}/webhook\nSecret: ${secret}`;
    navigator.clipboard.writeText(text).then(() => {
        alert('Configuração copiada!');
    });
}

async function fetchNgrokUrl() {
    try {
        const r = await fetch('http://localhost:4040/api/tunnels');
        const d = await r.json();
        if (d.tunnels && d.tunnels.length > 0) {
            const url = d.tunnels[0].public_url;
            document.getElementById('webhookUrl').value = url;
            document.getElementById('webhookUrl').style.background = 'rgba(76,175,80,0.3)';
        }
    } catch(e) {
        // ngrok não está rodando, usuário pode colar manualmente
    }
}

// Tenta buscar URL do ngrok a cada 5 segundos
setInterval(fetchNgrokUrl, 5000);
fetchNgrokUrl();

function toggleWatch() {
    const panel = document.getElementById('watchPanel');
    watchVisible = !watchVisible;
    panel.style.display = watchVisible ? 'block' : 'none';
    if (watchVisible) loadWebhooks();
}

async function loadWebhooks() {
    try {
        const r = await fetch('/webhooks');
        const d = await r.json();
        const list = document.getElementById('visitorList');
        if (!d.events || d.events.length === 0) {
            list.innerHTML = '<div style="opacity:0.6">Nenhum visitante ainda...</div>';
            return;
        }
        list.innerHTML = d.events.map(e => {
            const icon = e.is_entrada ? '🟢' : (e.is_saida ? '🔴' : '⚪');
            const action = e.is_entrada ? 'Entrada' : (e.is_saida ? 'Saída' : 'Evento');
            const nome = e.nome || 'Desconhecido';
            return `<div style="padding:8px;margin:5px 0;background:rgba(255,255,255,0.1);border-radius:8px;display:flex;align-items:center;gap:10px">
                <span style="font-size:1.5em">${icon}</span>
                <div>
                    <div style="font-weight:bold">${nome}</div>
                    <div style="opacity:0.7;font-size:0.85em">${action} - ${e.timestamp}</div>
                </div>
            </div>`;
        }).join('');
    } catch(e) {
        console.error('Erro ao carregar webhooks:', e);
    }
}


// Atualiza lista de visitantes a cada 5 segundos se visível
setInterval(() => { if (watchVisible) loadWebhooks(); }, 5000);

checkBleStatus().then(() => {
    setTimeout(() => start(), 500);
});

// Carrega webhooks ao iniciar
loadWebhooks();
</script>
</body>
</html>'''

class HTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())

    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML.encode())
        elif self.path == '/ble':
            connected = ble is not None and ble.is_connected
            self.send_json(200, {'ok': connected, 'auto_reconnect': True})
        elif self.path == '/context':
            ctx = load_context()
            self.send_json(200, ctx)
        elif self.path == '/webhooks':
            # Retorna eventos recebidos
            self.send_json(200, {'events': webhook_events})
        elif self.path == '/visitors':
            # Retorna visitantes pendentes
            self.send_json(200, {'pending': len(pending_visitors), 'visitors': pending_visitors[:5]})
        elif self.path == '/debug':
            # Retorna último payload raw para debug
            self.send_json(200, last_raw_payload)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if self.path == '/context':
            try:
                ctx = json.loads(body.decode('utf-8'))
                save_context(ctx)
                print(f"[Contexto] Salvo: {ctx.get('nome', 'Sofia')}")
                self.send_json(200, {'ok': True})
            except Exception as e:
                self.send_json(400, {'ok': False, 'error': str(e)})

        elif self.path == '/webhook' or self.path == '/':
            # Recebe webhook do Valid Watch
            timestamp = self.headers.get('x-webhook-timestamp', '')
            signature = self.headers.get('x-webhook-signature', '')
            webhook_id = self.headers.get('x-webhook-id', '')

            print(f"\n[Webhook] POST recebido ({len(body)} bytes)")
            print(f"  x-webhook-id: {webhook_id or '(ausente)'}")

            # Verifica HMAC (apenas loga, não rejeita)
            sig_valid = True
            if WEBHOOK_SECRET and signature:
                sig_header = signature.strip()
                if sig_header.lower().startswith("sha256="):
                    received_hex = sig_header[7:].strip()
                else:
                    received_hex = sig_header
                payload_str = f"{timestamp}.{body.decode('utf-8')}"
                expected_hex = hmac_module.new(
                    WEBHOOK_SECRET.encode('utf-8'),
                    payload_str.encode('utf-8'),
                    hashlib.sha256
                ).hexdigest()
                sig_valid = hmac_module.compare_digest(expected_hex.lower(), received_hex.lower())
                if not sig_valid:
                    print(f"  [AVISO] Assinatura inválida")

            try:
                data = json.loads(body.decode('utf-8'))
                evento = processar_webhook(data)
                self.send_json(200, {'received': True, 'signatureValid': sig_valid, 'evento': evento})
            except json.JSONDecodeError as e:
                print(f"[Webhook] JSON inválido: {e}")
                self.send_json(400, {'error': 'Invalid JSON'})
        else:
            self.send_response(404)
            self.end_headers()

async def main():
    # Iniciar reconexão BLE automática
    print("[BLE] Iniciando reconexão automática...")
    start_ble_reconnect_thread()

    # Iniciar HTTP server em thread separada
    http_server = HTTPServer(('', HTTP_PORT), HTTPHandler)
    http_thread = threading.Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()
    print(f"HTTP: http://localhost:{HTTP_PORT}")

    # Iniciar WebSocket server
    print(f"WebSocket: ws://localhost:{WS_PORT}")
    print()
    print("Abra o browser e clique em Começar!")
    print()

    async with websockets.serve(handle_client, "localhost", WS_PORT):
        await asyncio.Future()  # Roda para sempre

if __name__ == '__main__':
    print("=" * 50)
    print("  Sofia - OpenAI Realtime API")
    print("  Conversa instantânea como ChatGPT Voice")
    print("=" * 50)
    print()

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nTchau!")
