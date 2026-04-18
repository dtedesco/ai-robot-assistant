#!/usr/bin/env python3
"""
Robert RS01 - Conversa Fluida por Voz
Fale naturalmente com o Robert - ele escuta e responde automaticamente
"""

import asyncio
import json
import os
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
from groq import Groq
from openai import OpenAI
from bleak import BleakClient
import subprocess

# Configuração
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
PORT = 8080
CONTEXTS_FILE = os.path.join(os.path.dirname(__file__), "contexts.json")

# Protocolo BLE
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def build_packet(action, speed=8, color=2):
    data = bytes([action, action, speed, 0, color, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

class RobertState:
    def __init__(self):
        self.groq = Groq(api_key=GROQ_API_KEY)
        self.openai = OpenAI(api_key=OPENAI_API_KEY)
        self.ble_client = None
        self.color = 2
        self.is_speaking = False
        self.history = []
        self.system_prompt = """Você é Robert, robô amigo. Responda em 1 frase curta e animada.
IMPORTANTE: Comece SEMPRE com uma emoção entre colchetes: [feliz], [triste], [bravo], [amor], [medo], [pensando], [animado]
Exemplo: [feliz] Oba, adoro brincar!"""

    def chat(self, message):
        self.history.append({"role": "user", "content": message})
        messages = [{"role": "system", "content": self.system_prompt}]
        messages += self.history[-6:]

        try:
            response = self.openai.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                max_tokens=60,
                temperature=0.8
            )
            reply = response.choices[0].message.content
            self.history.append({"role": "assistant", "content": reply})

            # Extrai emoção e define cor dos olhos
            emotion, text = self.parse_emotion(reply)
            self.set_emotion_color(emotion)

            return text
        except Exception as e:
            return "Opa, não entendi!"

    def parse_emotion(self, text):
        """Extrai emoção do texto e retorna (emoção, texto_limpo)"""
        import re
        match = re.match(r'\[(\w+)\]\s*', text)
        if match:
            emotion = match.group(1).lower()
            clean_text = text[match.end():]
            return emotion, clean_text
        return "feliz", text

    def set_emotion_color(self, emotion):
        """Define cor dos olhos baseado na emoção"""
        colors = {
            "feliz": 3,      # verde
            "animado": 4,    # amarelo
            "triste": 2,     # azul
            "bravo": 5,      # vermelho
            "amor": 6,       # roxo
            "medo": 7,       # branco
            "pensando": 6,   # roxo
        }
        self.color = colors.get(emotion, 2)
        run_async(send_ble(build_packet(77, color=self.color)))

state = RobertState()

# BLE
async def connect_ble():
    try:
        if state.ble_client is None or not state.ble_client.is_connected:
            state.ble_client = BleakClient(ROBERT_BLE_ADDR, timeout=10)
            await state.ble_client.connect()
        return True
    except:
        return False

async def send_ble(packet):
    try:
        if state.ble_client and state.ble_client.is_connected:
            await state.ble_client.write_gatt_char(WRITE_UUID, packet, response=False)
    except:
        pass

def run_async(coro):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()

def speak_and_animate(text):
    def animate():
        moves = [100, 200, 101, 201, 102, 202, 103, 203]
        i = 0
        while state.is_speaking:
            run_async(send_ble(build_packet(moves[i % len(moves)], color=state.color)))
            i += 1
            time.sleep(0.4)

    try:
        # Gera áudio rapidamente
        audio_file = "/tmp/robert_speech.mp3"
        with state.openai.audio.speech.with_streaming_response.create(
            model="tts-1",
            voice="nova",
            input=text
        ) as response:
            response.stream_to_file(audio_file)

        # Animação + áudio juntos
        state.is_speaking = True
        anim_thread = threading.Thread(target=animate)
        anim_thread.start()
        subprocess.run(["afplay", audio_file], check=False)
        state.is_speaking = False
        anim_thread.join()

    except:
        os.system(f'say "{text}"')

# HTML - Interface de conversa fluida
HTML_PAGE = '''<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Robert - Conversa por Voz</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            color: white;
        }

        .container {
            text-align: center;
            padding: 40px;
        }

        h1 {
            font-size: 3em;
            margin-bottom: 10px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
        }

        .subtitle {
            font-size: 1.2em;
            opacity: 0.9;
            margin-bottom: 50px;
        }

        .robot-face {
            width: 200px;
            height: 200px;
            background: white;
            border-radius: 50%;
            margin: 0 auto 40px;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            position: relative;
            transition: all 0.3s;
        }

        .robot-face.listening {
            box-shadow: 0 0 0 20px rgba(255,255,255,0.2), 0 0 0 40px rgba(255,255,255,0.1);
            animation: pulse 1.5s infinite;
        }

        .robot-face.thinking {
            background: linear-gradient(45deg, #f0f0f0, #e0e0e0);
        }

        .robot-face.speaking {
            animation: speak 0.3s infinite;
        }

        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }

        @keyframes speak {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.02); }
        }

        .eyes {
            display: flex;
            gap: 30px;
        }

        .eye {
            width: 30px;
            height: 30px;
            background: #333;
            border-radius: 50%;
            position: relative;
        }

        .eye::after {
            content: '';
            position: absolute;
            width: 10px;
            height: 10px;
            background: white;
            border-radius: 50%;
            top: 5px;
            right: 5px;
        }

        .status {
            font-size: 1.5em;
            margin-bottom: 30px;
            min-height: 40px;
        }

        .status.listening { color: #4CAF50; }
        .status.thinking { color: #FFC107; }
        .status.speaking { color: #2196F3; }
        .status.error { color: #f44336; }

        .transcript-box {
            background: rgba(255,255,255,0.15);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 25px 40px;
            margin: 20px auto;
            max-width: 600px;
            min-height: 80px;
        }

        .transcript-box .user {
            color: #FFE082;
            font-size: 1.1em;
        }

        .transcript-box .assistant {
            color: #B2FF59;
            font-size: 1.2em;
            margin-top: 10px;
        }

        .start-btn {
            background: white;
            color: #667eea;
            border: none;
            padding: 20px 50px;
            font-size: 1.3em;
            border-radius: 50px;
            cursor: pointer;
            box-shadow: 0 10px 30px rgba(0,0,0,0.2);
            transition: all 0.3s;
            margin-top: 30px;
        }

        .start-btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 40px rgba(0,0,0,0.3);
        }

        .start-btn.active {
            background: #4CAF50;
            color: white;
        }

        .start-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .instructions {
            margin-top: 40px;
            opacity: 0.8;
            font-size: 0.95em;
        }

        .colors {
            position: fixed;
            bottom: 20px;
            left: 20px;
            display: flex;
            gap: 10px;
        }

        .color-btn {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            border: 3px solid white;
            cursor: pointer;
            transition: transform 0.2s;
        }

        .color-btn:hover { transform: scale(1.1); }
        .color-1 { background: #1a237e; }
        .color-2 { background: #2196F3; }
        .color-3 { background: #4CAF50; }
        .color-4 { background: #FFEB3B; }
        .color-5 { background: #f44336; }
        .color-6 { background: #9C27B0; }
        .color-7 { background: #FFFFFF; }

        .ble-status {
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 10px 20px;
            background: rgba(0,0,0,0.3);
            border-radius: 20px;
            cursor: pointer;
        }

        .ble-status.connected { background: rgba(76, 175, 80, 0.5); }
    </style>
</head>
<body>
    <div class="container">
        <h1>Robert</h1>
        <p class="subtitle">Seu amigo robô que conversa com você</p>

        <div class="robot-face" id="robotFace">
            <div class="eyes">
                <div class="eye"></div>
                <div class="eye"></div>
            </div>
        </div>

        <div class="status" id="status">Clique para começar a conversar</div>

        <div class="transcript-box" id="transcript">
            <div class="user" id="userText"></div>
            <div class="assistant" id="assistantText"></div>
        </div>

        <button class="start-btn" id="startBtn" onclick="toggleConversation()">
            Iniciar Conversa
        </button>

        <p class="instructions">
            Fale naturalmente - Robert vai ouvir e responder automaticamente
        </p>
    </div>

    <div class="colors">
        <button class="color-btn color-1" onclick="setColor(1)"></button>
        <button class="color-btn color-2" onclick="setColor(2)"></button>
        <button class="color-btn color-3" onclick="setColor(3)"></button>
        <button class="color-btn color-4" onclick="setColor(4)"></button>
        <button class="color-btn color-5" onclick="setColor(5)"></button>
        <button class="color-btn color-6" onclick="setColor(6)"></button>
        <button class="color-btn color-7" onclick="setColor(7)"></button>
    </div>

    <div class="ble-status" id="bleStatus" onclick="connectBLE()">
        BLE: Desconectado
    </div>

    <script>
        let recognition = null;
        let isConversing = false;
        let isSpeaking = false;

        // Inicializa reconhecimento de voz
        function initSpeechRecognition() {
            if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
                alert('Seu navegador não suporta reconhecimento de voz. Use o Chrome.');
                return false;
            }

            const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
            recognition = new SpeechRecognition();
            recognition.lang = 'pt-BR';
            recognition.continuous = true;
            recognition.interimResults = true;

            recognition.onresult = (event) => {
                let finalTranscript = '';
                let interimTranscript = '';

                for (let i = event.resultIndex; i < event.results.length; i++) {
                    const transcript = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        finalTranscript += transcript;
                    } else {
                        interimTranscript += transcript;
                    }
                }

                // Mostra o que está sendo dito
                if (interimTranscript) {
                    document.getElementById('userText').textContent = 'Você: ' + interimTranscript;
                }

                // Quando termina uma frase, processa
                if (finalTranscript && !isSpeaking) {
                    processUserInput(finalTranscript);
                }
            };

            recognition.onerror = (event) => {
                console.error('Erro:', event.error);
                if (event.error === 'no-speech') {
                    // Continua ouvindo
                    if (isConversing && !isSpeaking) {
                        setTimeout(startListening, 100);
                    }
                }
            };

            recognition.onend = () => {
                // Reinicia automaticamente se ainda está conversando
                if (isConversing && !isSpeaking) {
                    setTimeout(startListening, 100);
                }
            };

            return true;
        }

        function startListening() {
            if (!isConversing || isSpeaking) return;

            try {
                recognition.start();
                setStatus('listening', 'Ouvindo...');
                document.getElementById('robotFace').className = 'robot-face listening';
            } catch (e) {
                // Já está ouvindo
            }
        }

        function stopListening() {
            try {
                recognition.stop();
            } catch (e) {}
        }

        async function processUserInput(text) {
            if (!text.trim()) return;

            stopListening();
            isSpeaking = true;

            document.getElementById('userText').textContent = 'Você: ' + text;
            setStatus('thinking', 'Pensando...');
            document.getElementById('robotFace').className = 'robot-face thinking';

            try {
                const res = await fetch('/api/chat?message=' + encodeURIComponent(text));
                const data = await res.json();

                if (data.reply) {
                    document.getElementById('assistantText').textContent = 'Robert: ' + data.reply;
                    setStatus('speaking', 'Falando...');
                    document.getElementById('robotFace').className = 'robot-face speaking';

                    // Espera o Robert terminar de falar
                    await waitForSpeech(data.reply);
                }
            } catch (e) {
                console.error('Erro:', e);
                setStatus('error', 'Erro de conexão');
            }

            isSpeaking = false;

            // Volta a ouvir
            if (isConversing) {
                startListening();
            }
        }

        function waitForSpeech(text) {
            // Estima tempo: ~10 chars por segundo
            const duration = Math.max(1000, text.length * 80);
            return new Promise(resolve => setTimeout(resolve, duration));
        }

        function toggleConversation() {
            if (!recognition && !initSpeechRecognition()) {
                return;
            }

            isConversing = !isConversing;
            const btn = document.getElementById('startBtn');

            if (isConversing) {
                btn.textContent = 'Parar Conversa';
                btn.classList.add('active');
                startListening();
            } else {
                btn.textContent = 'Iniciar Conversa';
                btn.classList.remove('active');
                stopListening();
                setStatus('', 'Conversa pausada');
                document.getElementById('robotFace').className = 'robot-face';
            }
        }

        function setStatus(type, text) {
            const status = document.getElementById('status');
            status.textContent = text;
            status.className = 'status ' + type;
        }

        async function setColor(c) {
            await fetch('/api/color?c=' + c);
        }

        async function connectBLE() {
            const status = document.getElementById('bleStatus');
            status.textContent = 'BLE: Conectando...';
            const res = await fetch('/api/connect');
            const data = await res.json();
            status.textContent = data.ok ? 'BLE: Conectado' : 'BLE: Erro';
            if (data.ok) status.classList.add('connected');
        }

        // Inicia automaticamente ao carregar
        window.onload = () => {
            connectBLE();
            setTimeout(() => toggleConversation(), 500);
        };
    </script>
</body>
</html>
'''

class RobertHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())

        elif path == '/api/chat':
            message = unquote(params.get('message', [''])[0])
            reply = state.chat(message)
            threading.Thread(target=speak_and_animate, args=(reply,)).start()
            self.json_response({'reply': reply})

        elif path == '/api/connect':
            ok = run_async(connect_ble())
            self.json_response({'ok': ok})

        elif path == '/api/color':
            c = int(params.get('c', [2])[0])
            state.color = c
            run_async(send_ble(build_packet(77, color=c)))
            self.json_response({'ok': True})

        elif path == '/api/clear':
            state.history = []
            self.json_response({'ok': True})

        else:
            self.send_response(404)
            self.end_headers()

    def json_response(self, data):
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode())


if __name__ == '__main__':
    print("=" * 50)
    print("   Robert - Conversa Fluida por Voz")
    print("=" * 50)
    print()
    print(f"Abra no Chrome: http://localhost:{PORT}")
    print()
    print("Clique em 'Iniciar Conversa' e fale naturalmente!")
    print("Robert vai ouvir e responder automaticamente.")
    print()

    server = HTTPServer(('', PORT), RobertHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nTchau!")
