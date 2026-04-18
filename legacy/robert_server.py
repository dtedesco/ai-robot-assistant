#!/usr/bin/env python3
"""
Robert RS01 - Servidor Web para Controle
Rode este servidor e abra http://localhost:8080 no Chrome
"""

import asyncio
import json
import subprocess
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import threading
from bleak import BleakClient, BleakScanner

# Configuração
ADDR = '086A5A8E-A325-A536-F7B9-80104F42500F'
WRITE_UUID = '0000ffc1-0000-1000-8000-00805f9b34fb'
PORT = 8080

# Protocolo
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def build_packet(action, speed=8, color=2, color_mode=0):
    data = bytes([action, action, speed, 0, color, color_mode, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

def build_stop():
    return HEADER + bytes([0x0C]) + FOOTER

# Cliente BLE global
ble_client = None
ble_lock = threading.Lock()

async def send_ble_command(packet):
    global ble_client
    try:
        if ble_client is None or not ble_client.is_connected:
            print("Conectando BLE...")
            ble_client = BleakClient(ADDR, timeout=10)
            await ble_client.connect()
            print("BLE conectado!")

        await ble_client.write_gatt_char(WRITE_UUID, packet, response=False)
        return True
    except Exception as e:
        print(f"Erro BLE: {e}")
        ble_client = None
        return False

def run_async(coro):
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()

class RobertHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == '/':
            self.send_response(200)
            self.send_header('Content-type', 'text/html')
            self.end_headers()
            self.wfile.write(HTML_PAGE.encode())

        elif parsed.path == '/cmd':
            params = parse_qs(parsed.query)
            action = params.get('action', [''])[0]
            value_str = params.get('value', ['0'])[0]
            color = int(params.get('color', [2])[0])

            # Tenta converter para int, senão mantém como string
            try:
                value = int(value_str)
            except:
                value = value_str

            result = self.handle_command(action, value, color)

            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def handle_command(self, action, value, color):
        try:
            if action == 'arm':
                packet = build_packet(100 + value, color=color)
                success = run_async(send_ble_command(packet))
                return {'ok': success, 'msg': f'Braço {100+value}'}

            elif action == 'leg':
                packet = build_packet(200 + value, color=color)
                success = run_async(send_ble_command(packet))
                return {'ok': success, 'msg': f'Perna {200+value}'}

            elif action == 'dance':
                packet = build_packet(value, color=color)
                success = run_async(send_ble_command(packet))
                return {'ok': success, 'msg': f'Dança {value}'}

            elif action == 'color':
                packet = build_packet(77, color=value)
                success = run_async(send_ble_command(packet))
                return {'ok': success, 'msg': f'Cor {value}'}

            elif action == 'move':
                directions = {'up': 2, 'down': 1, 'left': 3, 'right': 4}
                d = directions.get(str(value), 2)
                packet = build_packet(d, speed=255, color=color)
                print(f"Move: {value} -> action {d}, packet: {packet.hex()}")
                success = run_async(send_ble_command(packet))
                return {'ok': success, 'msg': f'Movimento {value}'}

            elif action == 'stop':
                packet = build_stop()
                success = run_async(send_ble_command(packet))
                return {'ok': success, 'msg': 'Parado'}

            elif action == 'say':
                import os
                from urllib.parse import unquote
                text = unquote(str(value)) if value else 'Olá, eu sou o Robert'
                text = text.replace('"', '\\"').replace("'", "\\'")
                print(f"Say: {text}")
                os.system(f'say -v Luciana "{text}" &')
                return {'ok': True, 'msg': f'Falando: {text}'}

            elif action == 'connect':
                success = run_async(send_ble_command(build_packet(77)))
                return {'ok': success, 'msg': 'Conectado!' if success else 'Falha na conexão'}

            else:
                return {'ok': False, 'msg': f'Comando desconhecido: {action}'}

        except Exception as e:
            return {'ok': False, 'msg': str(e)}

HTML_PAGE = '''<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Robert RS01 - Controle</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: white;
            padding: 20px;
        }
        h1 {
            text-align: center;
            margin-bottom: 20px;
            font-size: 2em;
        }
        .status {
            text-align: center;
            padding: 10px;
            margin-bottom: 20px;
            border-radius: 10px;
            background: #0f3460;
        }
        .section {
            background: rgba(255,255,255,0.1);
            border-radius: 15px;
            padding: 15px;
            margin-bottom: 15px;
        }
        .section h2 {
            font-size: 1.2em;
            margin-bottom: 10px;
            color: #e94560;
        }
        .buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }
        button {
            padding: 15px 25px;
            font-size: 16px;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
            font-weight: bold;
        }
        button:hover { transform: scale(1.05); }
        button:active { transform: scale(0.95); }
        .btn-arm { background: #e94560; color: white; }
        .btn-leg { background: #0f3460; color: white; }
        .btn-dance { background: #533483; color: white; }
        .btn-move { background: #1a1a2e; color: white; border: 2px solid #e94560; }
        .btn-stop { background: #ff0000; color: white; font-size: 20px; }
        .btn-connect { background: #00ff00; color: black; }
        .colors {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
        }
        .color-btn {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            border: 3px solid white;
        }
        .color-1 { background: #00008B; }
        .color-2 { background: #0066ff; }
        .color-3 { background: #00ff00; }
        .color-4 { background: #ffff00; }
        .color-5 { background: #ff0000; }
        .color-6 { background: #800080; }
        .color-7 { background: #ffffff; }
        .dpad {
            display: grid;
            grid-template-columns: repeat(3, 60px);
            grid-template-rows: repeat(3, 60px);
            gap: 5px;
            justify-content: center;
        }
        .dpad button {
            padding: 10px;
            font-size: 24px;
        }
        .say-input {
            display: flex;
            gap: 10px;
            margin-top: 10px;
        }
        .say-input input {
            flex: 1;
            padding: 15px;
            border-radius: 10px;
            border: none;
            font-size: 16px;
        }
        #log {
            background: #000;
            padding: 10px;
            border-radius: 10px;
            font-family: monospace;
            font-size: 12px;
            max-height: 150px;
            overflow-y: auto;
        }
    </style>
</head>
<body>
    <h1>🤖 Robert RS01</h1>

    <div class="status" id="status">Clique em "Conectar" para iniciar</div>

    <div class="section">
        <h2>Conexão</h2>
        <div class="buttons">
            <button class="btn-connect" onclick="cmd('connect')">🔌 Conectar</button>
            <button class="btn-stop" onclick="cmd('stop')">⏹ PARAR</button>
        </div>
    </div>

    <div class="section">
        <h2>🎨 Cores dos Olhos</h2>
        <div class="colors">
            <button class="color-btn color-1" onclick="cmd('color', 1)" title="Azul Escuro"></button>
            <button class="color-btn color-2" onclick="cmd('color', 2)" title="Azul"></button>
            <button class="color-btn color-3" onclick="cmd('color', 3)" title="Verde"></button>
            <button class="color-btn color-4" onclick="cmd('color', 4)" title="Amarelo"></button>
            <button class="color-btn color-5" onclick="cmd('color', 5)" title="Vermelho"></button>
            <button class="color-btn color-6" onclick="cmd('color', 6)" title="Roxo"></button>
            <button class="color-btn color-7" onclick="cmd('color', 7)" title="Branco"></button>
        </div>
    </div>

    <div class="section">
        <h2>💪 Braços (100-110)</h2>
        <div class="buttons">
            <button class="btn-arm" onclick="cmd('arm', 0)">100</button>
            <button class="btn-arm" onclick="cmd('arm', 1)">101</button>
            <button class="btn-arm" onclick="cmd('arm', 2)">102</button>
            <button class="btn-arm" onclick="cmd('arm', 3)">103</button>
            <button class="btn-arm" onclick="cmd('arm', 4)">104</button>
            <button class="btn-arm" onclick="cmd('arm', 5)">105</button>
            <button class="btn-arm" onclick="cmd('arm', 6)">106</button>
            <button class="btn-arm" onclick="cmd('arm', 7)">107</button>
            <button class="btn-arm" onclick="cmd('arm', 8)">108</button>
            <button class="btn-arm" onclick="cmd('arm', 9)">109</button>
            <button class="btn-arm" onclick="cmd('arm', 10)">110</button>
        </div>
    </div>

    <div class="section">
        <h2>🦵 Pernas (200-235)</h2>
        <div class="buttons">
            <button class="btn-leg" onclick="cmd('leg', 0)">200</button>
            <button class="btn-leg" onclick="cmd('leg', 5)">205</button>
            <button class="btn-leg" onclick="cmd('leg', 10)">210</button>
            <button class="btn-leg" onclick="cmd('leg', 15)">215</button>
            <button class="btn-leg" onclick="cmd('leg', 20)">220</button>
            <button class="btn-leg" onclick="cmd('leg', 25)">225</button>
            <button class="btn-leg" onclick="cmd('leg', 30)">230</button>
            <button class="btn-leg" onclick="cmd('leg', 35)">235</button>
        </div>
    </div>

    <div class="section">
        <h2>💃 Danças (1-93)</h2>
        <div class="buttons">
            <button class="btn-dance" onclick="cmd('dance', 1)">1</button>
            <button class="btn-dance" onclick="cmd('dance', 10)">10</button>
            <button class="btn-dance" onclick="cmd('dance', 20)">20</button>
            <button class="btn-dance" onclick="cmd('dance', 30)">30</button>
            <button class="btn-dance" onclick="cmd('dance', 40)">40</button>
            <button class="btn-dance" onclick="cmd('dance', 50)">50</button>
            <button class="btn-dance" onclick="cmd('dance', 60)">60</button>
            <button class="btn-dance" onclick="cmd('dance', 70)">70</button>
            <button class="btn-dance" onclick="cmd('dance', 80)">80</button>
            <button class="btn-dance" onclick="cmd('dance', 90)">90</button>
        </div>
    </div>

    <div class="section">
        <h2>🕹 Movimento</h2>
        <div class="dpad">
            <div></div>
            <button class="btn-move" onclick="cmd('move', 'up')">⬆️</button>
            <div></div>
            <button class="btn-move" onclick="cmd('move', 'left')">⬅️</button>
            <button class="btn-stop" onclick="cmd('stop')">⏹</button>
            <button class="btn-move" onclick="cmd('move', 'right')">➡️</button>
            <div></div>
            <button class="btn-move" onclick="cmd('move', 'down')">⬇️</button>
            <div></div>
        </div>
    </div>

    <div class="section">
        <h2>🗣 Falar</h2>
        <div class="say-input">
            <input type="text" id="sayText" placeholder="Digite o texto para falar...">
            <button class="btn-arm" onclick="speak()">🔊 Falar</button>
        </div>
        <div class="buttons" style="margin-top: 10px;">
            <button class="btn-dance" onclick="sayPreset('Olá, eu sou o Robert!')">Olá!</button>
            <button class="btn-dance" onclick="sayPreset('Vamos dançar!')">Dançar!</button>
            <button class="btn-dance" onclick="sayPreset('Tchau tchau!')">Tchau!</button>
        </div>
    </div>

    <div class="section">
        <h2>📜 Log</h2>
        <div id="log"></div>
    </div>

    <script>
        const status = document.getElementById('status');
        const log = document.getElementById('log');
        let currentColor = 2;

        function addLog(msg) {
            const time = new Date().toLocaleTimeString();
            log.innerHTML = `[${time}] ${msg}<br>` + log.innerHTML;
        }

        async function cmd(action, value = 0) {
            status.textContent = 'Enviando...';
            status.style.background = '#e94560';

            try {
                const url = `/cmd?action=${action}&value=${value}&color=${currentColor}`;
                const res = await fetch(url);
                const data = await res.json();

                if (data.ok) {
                    status.textContent = '✓ ' + data.msg;
                    status.style.background = '#00aa00';
                } else {
                    status.textContent = '✗ ' + data.msg;
                    status.style.background = '#aa0000';
                }
                addLog(data.msg);
            } catch (e) {
                status.textContent = '✗ Erro: ' + e.message;
                status.style.background = '#aa0000';
                addLog('Erro: ' + e.message);
            }
        }

        function speak() {
            const text = document.getElementById('sayText').value || 'Olá';
            cmd('say', text);
        }

        function sayPreset(text) {
            document.getElementById('sayText').value = text;
            cmd('say', text);
        }

        // Teclas de atalho
        document.addEventListener('keydown', (e) => {
            switch(e.key) {
                case 'ArrowUp': cmd('move', 'up'); break;
                case 'ArrowDown': cmd('move', 'down'); break;
                case 'ArrowLeft': cmd('move', 'left'); break;
                case 'ArrowRight': cmd('move', 'right'); break;
                case ' ': cmd('stop'); break;
            }
        });
    </script>
</body>
</html>
'''

if __name__ == '__main__':
    print(f"=" * 50)
    print(f"   Robert RS01 - Servidor Web")
    print(f"=" * 50)
    print()
    print(f"Abra no Chrome: http://localhost:{PORT}")
    print()
    print("Ctrl+C para parar")
    print()

    server = HTTPServer(('', PORT), RobertHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor parado")
        if ble_client:
            asyncio.run(ble_client.disconnect())
