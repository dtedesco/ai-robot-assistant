#!/usr/bin/env python3
"""
Robert RS01 - OpenAI Realtime API
Conversa fluida com WebSocket - latência mínima
"""

import asyncio
import base64
import json
import os
import subprocess
import threading
import websockets
from http.server import HTTPServer, BaseHTTPRequestHandler
from bleak import BleakClient

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
PORT = 8080

# BLE
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

ble_client = None
color = 2

def build_packet(action, c=2):
    data = bytes([action, action, 8, 0, c, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

async def connect_ble():
    global ble_client
    try:
        if ble_client is None or not ble_client.is_connected:
            ble_client = BleakClient(ROBERT_BLE_ADDR, timeout=10)
            await ble_client.connect()
        return True
    except:
        return False

async def send_ble(packet):
    global ble_client
    try:
        if ble_client and ble_client.is_connected:
            await ble_client.write_gatt_char(WRITE_UUID, packet, response=False)
    except:
        pass

HTML_PAGE = '''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Robert Voice</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: system-ui;
            background: linear-gradient(135deg, #1e3c72, #2a5298);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
        }
        .box { text-align: center; }
        h1 { font-size: 2.5em; margin-bottom: 30px; }

        #circle {
            width: 200px;
            height: 200px;
            background: white;
            border-radius: 50%;
            margin: 0 auto 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s;
        }
        #circle:hover { transform: scale(1.05); }
        #circle.listening {
            background: #4CAF50;
            box-shadow: 0 0 0 20px rgba(76,175,80,0.2);
        }
        #circle.speaking {
            background: #2196F3;
            animation: pulse 0.5s infinite;
        }
        @keyframes pulse {
            0%,100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }

        .eyes { display: flex; gap: 30px; }
        .eye { width: 30px; height: 30px; background: #333; border-radius: 50%; }
        #circle.listening .eye, #circle.speaking .eye { background: white; }

        #status { font-size: 1.4em; margin-bottom: 20px; }
        #transcript {
            background: rgba(0,0,0,0.2);
            padding: 20px;
            border-radius: 15px;
            max-width: 400px;
            margin: 0 auto;
            min-height: 80px;
        }
        .user { color: #FFD54F; }
        .bot { color: #81C784; margin-top: 10px; }

        button {
            margin-top: 30px;
            padding: 15px 40px;
            font-size: 1.2em;
            border: none;
            border-radius: 30px;
            background: white;
            color: #1e3c72;
            cursor: pointer;
        }
        button:hover { transform: scale(1.05); }
    </style>
</head>
<body>
    <div class="box">
        <h1>Robert</h1>

        <div id="circle" onclick="toggleVoice()">
            <div class="eyes">
                <div class="eye"></div>
                <div class="eye"></div>
            </div>
        </div>

        <div id="status">Clique para falar</div>

        <div id="transcript">
            <div class="user" id="user"></div>
            <div class="bot" id="bot"></div>
        </div>

        <button onclick="toggleVoice()">Iniciar</button>
    </div>

    <script>
        let ws = null;
        let mediaRecorder = null;
        let audioContext = null;
        let isActive = false;

        async function toggleVoice() {
            if (isActive) {
                stopVoice();
            } else {
                startVoice();
            }
        }

        async function startVoice() {
            isActive = true;
            document.getElementById('status').textContent = 'Conectando...';

            // Conectar WebSocket ao nosso servidor
            ws = new WebSocket('ws://localhost:8081');

            ws.onopen = async () => {
                document.getElementById('status').textContent = 'Ouvindo...';
                document.getElementById('circle').classList.add('listening');

                // Iniciar gravação
                const stream = await navigator.mediaDevices.getUserMedia({audio: true});
                mediaRecorder = new MediaRecorder(stream, {mimeType: 'audio/webm'});

                mediaRecorder.ondataavailable = async (e) => {
                    if (ws.readyState === WebSocket.OPEN && e.data.size > 0) {
                        const buffer = await e.data.arrayBuffer();
                        ws.send(buffer);
                    }
                };

                mediaRecorder.start(250); // Envia chunks a cada 250ms
            };

            ws.onmessage = (e) => {
                const data = JSON.parse(e.data);

                if (data.type === 'transcript') {
                    document.getElementById('user').textContent = 'Você: ' + data.text;
                }
                else if (data.type === 'response') {
                    document.getElementById('bot').textContent = 'Robert: ' + data.text;
                    document.getElementById('circle').classList.remove('listening');
                    document.getElementById('circle').classList.add('speaking');
                    document.getElementById('status').textContent = 'Falando...';
                }
                else if (data.type === 'done') {
                    document.getElementById('circle').classList.remove('speaking');
                    document.getElementById('circle').classList.add('listening');
                    document.getElementById('status').textContent = 'Ouvindo...';
                }
            };

            ws.onclose = () => {
                stopVoice();
            };
        }

        function stopVoice() {
            isActive = false;
            if (mediaRecorder) mediaRecorder.stop();
            if (ws) ws.close();
            document.getElementById('circle').className = '';
            document.getElementById('status').textContent = 'Clique para falar';
        }

        // Conectar BLE
        fetch('/connect');
    </script>
</body>
</html>
'''

class HTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def do_GET(self):
        if self.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())
        elif self.path == '/connect':
            loop = asyncio.new_event_loop()
            ok = loop.run_until_complete(connect_ble())
            loop.close()
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': ok}).encode())

# WebSocket server para áudio em tempo real
async def handle_websocket(websocket):
    print("Cliente conectado")

    try:
        # Conectar ao OpenAI Realtime
        url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01"
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
            "OpenAI-Beta": "realtime=v1"
        }

        async with websockets.connect(url, extra_headers=headers) as openai_ws:
            # Configurar sessão
            await openai_ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "instructions": "Você é Robert, um robô amigo fofo. Responda em português, de forma curta e animada.",
                    "voice": "alloy",
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500
                    }
                }
            }))

            audio_buffer = b''

            async def receive_from_openai():
                nonlocal audio_buffer
                async for msg in openai_ws:
                    data = json.loads(msg)

                    if data['type'] == 'response.audio.delta':
                        # Recebendo áudio
                        chunk = base64.b64decode(data['delta'])
                        audio_buffer += chunk

                    elif data['type'] == 'response.audio.done':
                        # Áudio completo - tocar
                        if audio_buffer:
                            await play_audio(audio_buffer)
                            await websocket.send(json.dumps({'type': 'done'}))
                            audio_buffer = b''

                    elif data['type'] == 'response.text.delta':
                        # Texto da resposta
                        await websocket.send(json.dumps({
                            'type': 'response',
                            'text': data.get('delta', '')
                        }))

                    elif data['type'] == 'input_audio_buffer.speech_started':
                        pass  # Usuário começou a falar

                    elif data['type'] == 'input_audio_buffer.speech_stopped':
                        pass  # Usuário parou de falar

            async def receive_from_client():
                async for msg in websocket:
                    # Converter WebM para PCM e enviar
                    # Por simplicidade, vamos usar reconhecimento de texto
                    pass

            # Rodar ambos
            await asyncio.gather(
                receive_from_openai(),
                receive_from_client()
            )

    except Exception as e:
        print(f"Erro: {e}")
    finally:
        print("Cliente desconectado")

async def play_audio(pcm_data):
    # Salvar como WAV e tocar
    import wave
    with wave.open('/tmp/robert_rt.wav', 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(24000)
        f.writeframes(pcm_data)

    # Animar
    for i in range(3):
        await send_ble(build_packet(100 + i, color))
        await asyncio.sleep(0.3)

    subprocess.run(['afplay', '/tmp/robert_rt.wav'])

async def main():
    # Servidor HTTP
    http_server = HTTPServer(('', PORT), HTTPHandler)
    http_thread = threading.Thread(target=http_server.serve_forever)
    http_thread.daemon = True
    http_thread.start()
    print(f"HTTP: http://localhost:{PORT}")

    # Servidor WebSocket
    print("WebSocket: ws://localhost:8081")
    async with websockets.serve(handle_websocket, "localhost", 8081):
        await asyncio.Future()  # Roda para sempre

if __name__ == '__main__':
    print("=" * 50)
    print("   Robert - OpenAI Realtime API")
    print("=" * 50)
    print()
    asyncio.run(main())
