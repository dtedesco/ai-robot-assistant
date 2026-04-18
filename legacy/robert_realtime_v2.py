#!/usr/bin/env python3
"""
Robert RS01 - OpenAI Realtime API
Conversa fluida como ChatGPT Voice
"""

import asyncio
import base64
import json
import os
import struct
import threading
import time
import wave
from http.server import HTTPServer, BaseHTTPRequestHandler
from bleak import BleakClient

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
HTTP_PORT = 8080
WS_PORT = 8081

# BLE
ble = None
color = 2
speaking = False

HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def packet(action, c):
    data = bytes([action, action, 8, 0, c, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

def ble_run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()

async def ble_connect():
    global ble
    try:
        ble = BleakClient(ROBERT_BLE_ADDR, timeout=10)
        await ble.connect()
        return True
    except:
        return False

async def ble_send(action):
    global ble, color
    try:
        if ble and ble.is_connected:
            await ble.write_gatt_char(WRITE_UUID, packet(action, color), response=False)
    except:
        pass

def set_color(c):
    global color
    color = c
    ble_run(ble_send(77))

def animate_loop():
    global speaking
    arms = [100, 102, 104, 106, 108, 110]
    legs = [200, 202, 204, 206, 208, 210]
    i = 0
    while speaking:
        ble_run(ble_send(arms[i % len(arms)]))
        ble_run(ble_send(legs[i % len(legs)]))
        time.sleep(0.2)
        i += 1

HTML = '''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Robert Realtime</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:linear-gradient(135deg,#1a1a2e,#16213e);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.c{text-align:center;padding:20px;max-width:450px}
h1{font-size:2.2em;margin-bottom:10px}
.sub{opacity:0.7;margin-bottom:20px}
#face{width:180px;height:180px;background:#fff;border-radius:50%;margin:20px auto;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.3s}
#face.listen{background:#4CAF50;box-shadow:0 0 0 20px rgba(76,175,80,.2)}
#face.think{background:#FFC107}
#face.speak{background:#9C27B0;animation:pulse .3s infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.03)}}
.eyes{display:flex;gap:30px}
.eye{width:25px;height:25px;background:#333;border-radius:50%}
#face.listen .eye,#face.think .eye,#face.speak .eye{background:#fff}
#status{font-size:1.4em;margin:20px 0}
#box{background:rgba(255,255,255,.1);padding:20px;border-radius:15px;min-height:80px}
.you{color:#FFE082}
.rob{color:#B2FF59;margin-top:10px}
.btns{display:flex;gap:15px;justify-content:center;margin-top:25px}
button{padding:18px 40px;font-size:1.2em;border:none;border-radius:30px;cursor:pointer;font-weight:600;transition:.2s}
button:hover{transform:scale(1.05)}
#startBtn{background:#4CAF50;color:#fff}
#startBtn.on{background:#f44336}
#danceBtn{background:#FF69B4;color:#fff}
</style>
</head>
<body>
<div class="c">
<h1>Robert</h1>
<p class="sub">Realtime Voice - Conversa Instantânea</p>
<div id="face"><div class="eyes"><div class="eye"></div><div class="eye"></div></div></div>
<div id="status">Clique para começar</div>
<div id="box"><div class="you" id="you"></div><div class="rob" id="rob"></div></div>
<div class="btns">
<button id="startBtn" onclick="toggle()">Começar</button>
<button id="danceBtn" onclick="dance()">Dancinha</button>
</div>
</div>

<script>
const WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17';
const API_KEY = '""" + OPENAI_API_KEY + """';

let ws = null;
let audioCtx = null;
let mediaStream = null;
let processor = null;
let isActive = false;
let audioQueue = [];
let isPlaying = false;

async function toggle() {
    if (isActive) {
        stop();
    } else {
        start();
    }
}

async function start() {
    isActive = true;
    document.getElementById('startBtn').textContent = 'Parar';
    document.getElementById('startBtn').classList.add('on');
    setUI('think', 'Conectando...');

    try {
        // Conectar ao OpenAI Realtime
        ws = new WebSocket(WS_URL, [
            'realtime',
            'openai-insecure-api-key.' + API_KEY,
            'openai-beta.realtime-v1'
        ]);

        ws.onopen = async () => {
            console.log('WebSocket conectado');

            // Configurar sessão
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    modalities: ['text', 'audio'],
                    instructions: 'Você é Robert, um robô amigo muito simpático e divertido. Fale em português brasileiro de forma natural e animada. Seja conversacional e amigável.',
                    voice: 'shimmer',
                    input_audio_format: 'pcm16',
                    output_audio_format: 'pcm16',
                    input_audio_transcription: { model: 'whisper-1' },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500
                    }
                }
            }));

            // Iniciar captura de áudio
            await startAudio();
            setUI('listen', 'Ouvindo...');
            fetch('/listen');
        };

        ws.onmessage = (e) => {
            const msg = JSON.parse(e.data);
            handleMessage(msg);
        };

        ws.onerror = (e) => {
            console.error('WebSocket erro:', e);
            stop();
        };

        ws.onclose = () => {
            console.log('WebSocket fechado');
            if (isActive) stop();
        };

    } catch (e) {
        console.error('Erro:', e);
        stop();
    }
}

function handleMessage(msg) {
    console.log('Msg:', msg.type);

    switch (msg.type) {
        case 'session.created':
            console.log('Sessão criada');
            break;

        case 'input_audio_buffer.speech_started':
            setUI('listen', 'Ouvindo...');
            break;

        case 'input_audio_buffer.speech_stopped':
            setUI('think', 'Pensando...');
            fetch('/think');
            break;

        case 'conversation.item.input_audio_transcription.completed':
            if (msg.transcript) {
                document.getElementById('you').textContent = 'Você: ' + msg.transcript;
            }
            break;

        case 'response.audio.delta':
            if (msg.delta) {
                const audio = base64ToInt16(msg.delta);
                audioQueue.push(audio);
                if (!isPlaying) playQueue();
            }
            break;

        case 'response.audio_transcript.delta':
            if (msg.delta) {
                const el = document.getElementById('rob');
                el.textContent = (el.textContent || 'Robert: ') + msg.delta;
            }
            break;

        case 'response.audio.done':
            setUI('listen', 'Ouvindo...');
            fetch('/listen');
            document.getElementById('rob').textContent = '';
            break;

        case 'response.done':
            break;
    }
}

async function startAudio() {
    audioCtx = new AudioContext({ sampleRate: 24000 });

    mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            sampleRate: 24000,
            echoCancellation: true,
            noiseSuppression: true
        }
    });

    const source = audioCtx.createMediaStreamSource(mediaStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;

        const input = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(input.length);
        for (let i = 0; i < input.length; i++) {
            pcm16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
        }

        ws.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: int16ToBase64(pcm16)
        }));
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);
}

async function playQueue() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }

    isPlaying = true;
    setUI('speak', 'Falando...');
    fetch('/speak');

    while (audioQueue.length > 0) {
        const pcm16 = audioQueue.shift();
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
            float32[i] = pcm16[i] / 32768;
        }

        const buffer = audioCtx.createBuffer(1, float32.length, 24000);
        buffer.getChannelData(0).set(float32);

        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(audioCtx.destination);
        src.start();

        await new Promise(r => setTimeout(r, (float32.length / 24000) * 1000));
    }

    isPlaying = false;
}

function stop() {
    isActive = false;
    document.getElementById('startBtn').textContent = 'Começar';
    document.getElementById('startBtn').classList.remove('on');

    if (ws) { ws.close(); ws = null; }
    if (processor) { processor.disconnect(); processor = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }

    audioQueue = [];
    isPlaying = false;
    setUI('', 'Clique para começar');
    fetch('/ready');
}

async function dance() {
    if (isActive) stop();
    setUI('speak', 'Dançando!');
    await fetch('/dance');
    setUI('', 'Clique para começar');
}

function setUI(cls, txt) {
    document.getElementById('face').className = cls;
    document.getElementById('status').textContent = txt;
}

function base64ToInt16(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Int16Array(bytes.buffer);
}

function int16ToBase64(int16) {
    const bytes = new Uint8Array(int16.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// Conectar BLE ao carregar
fetch('/ble');
</script>
</body>
</html>'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def do_GET(self):
        global speaking
        path = self.path.split('?')[0]

        if path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML.encode())

        elif path == '/ble':
            ok = ble_run(ble_connect())
            set_color(2)
            self.json({'ok': ok})

        elif path == '/listen':
            set_color(3)  # Verde
            self.json({'ok': True})

        elif path == '/think':
            set_color(4)  # Amarelo
            self.json({'ok': True})

        elif path == '/speak':
            set_color(6)  # Roxo
            if not speaking:
                speaking = True
                threading.Thread(target=animate_loop, daemon=True).start()
            self.json({'ok': True})

        elif path == '/ready':
            speaking = False
            set_color(2)  # Azul
            self.json({'ok': True})

        elif path == '/dance':
            dance()
            self.json({'ok': True})

        else:
            self.send_response(404)
            self.end_headers()

    def json(self, d):
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(d).encode())

def dance():
    global speaking, color
    from openai import OpenAI
    client = OpenAI(api_key=OPENAI_API_KEY)

    music_file = "/tmp/dance.mp3"
    if not os.path.exists(music_file):
        audio = client.audio.speech.create(
            model="tts-1",
            voice="nova",
            input="Tum tum tum! Vamos dançar! Pra lá, pra cá! Mexe o corpinho! Eba!"
        )
        with open(music_file, 'wb') as f:
            f.write(audio.content)

    import subprocess
    moves = [(1, 100, 200), (3, 102, 202), (2, 104, 204), (4, 106, 206), (6, 108, 208), (5, 110, 210)]
    speaking = True

    def coreografia():
        i = 0
        while speaking:
            m = moves[i % len(moves)]
            set_color(m[0])
            ble_run(ble_send(m[1]))
            ble_run(ble_send(m[2]))
            time.sleep(0.3)
            i += 1

    t = threading.Thread(target=coreografia, daemon=True)
    t.start()
    subprocess.run(['afplay', music_file], capture_output=True)
    speaking = False
    set_color(2)

def check_ble():
    global ble
    while True:
        time.sleep(10)
        try:
            if ble is None or not ble.is_connected:
                print("Reconectando BLE...")
                ble_run(ble_connect())
                if ble and ble.is_connected:
                    print("BLE OK!")
                    set_color(2)
        except:
            pass

if __name__ == '__main__':
    print("=" * 45)
    print("  Robert - OpenAI Realtime API")
    print("  http://localhost:8080")
    print("  Conversa instantânea como ChatGPT Voice!")
    print("=" * 45)

    threading.Thread(target=check_ble, daemon=True).start()
    HTTPServer(('', HTTP_PORT), Handler).serve_forever()
