#!/usr/bin/env python3
"""
Robert RS01 - Versão Otimizada
Máxima fluidez na conversa
"""

import asyncio
import json
import os
import subprocess
import threading
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
from openai import OpenAI
from bleak import BleakClient
from concurrent.futures import ThreadPoolExecutor

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
PORT = 8080

# Cliente OpenAI (reutilizado)
client = OpenAI(api_key=OPENAI_API_KEY)

# Estado global
ble = None
ble_loop = None
ble_lock = threading.Lock()
speaking = False
color = 2
executor = ThreadPoolExecutor(max_workers=4)

# Protocolo BLE
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def packet(action, c):
    data = bytes([action, action, 8, 0, c, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

# Event loop persistente para BLE
def get_ble_loop():
    global ble_loop
    if ble_loop is None or not ble_loop.is_running():
        ble_loop = asyncio.new_event_loop()
    return ble_loop

def ble_run(coro):
    with ble_lock:
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

def animate():
    """Anima braços E pernas - mais rápido"""
    global speaking
    arms = [100, 102, 104, 106, 108, 110]
    legs = [200, 202, 204, 206, 208, 210]
    i = 0
    while speaking:
        ble_run(ble_send(arms[i % len(arms)]))
        ble_run(ble_send(legs[i % len(legs)]))
        time.sleep(0.2)
        i += 1

def chat_speak(text):
    """Chat + TTS otimizado"""
    global speaking

    # AMARELO = processando
    set_color(4)

    # Chat rápido com streaming
    reply_parts = []
    stream = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Robô amigo. 2-3 frases."},
            {"role": "user", "content": text}
        ],
        max_tokens=50,
        stream=True
    )

    for chunk in stream:
        if chunk.choices[0].delta.content:
            reply_parts.append(chunk.choices[0].delta.content)

    reply = ''.join(reply_parts)

    # TTS com streaming para arquivo
    with client.audio.speech.with_streaming_response.create(
        model="tts-1",
        voice="nova",
        input=reply,
        response_format="mp3"
    ) as response:
        response.stream_to_file('/tmp/rob.mp3')

    # ROXO = falando
    set_color(6)

    speaking = True
    t = threading.Thread(target=animate, daemon=True)
    t.start()
    subprocess.run(['afplay', '/tmp/rob.mp3'], capture_output=True)
    speaking = False

    # VERDE = ouvindo (já volta pronto)
    set_color(3)

    return reply

def dance():
    """Modo dancinha"""
    global speaking, color

    music_file = "/tmp/dance.mp3"
    if not os.path.exists(music_file):
        audio = client.audio.speech.create(
            model="tts-1",
            voice="nova",
            input="Tum tum tum! Vamos dançar! Pra lá, pra cá! Mexe o corpinho! Eba!"
        )
        with open(music_file, 'wb') as f:
            f.write(audio.content)

    moves = [
        (1, 100, 200), (3, 102, 202), (2, 104, 204),
        (4, 106, 206), (6, 108, 208), (5, 110, 210),
    ]

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

HTML = '''<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Robert</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}
.c{text-align:center;padding:20px;max-width:400px}
h1{font-size:2.2em;margin-bottom:15px;text-shadow:2px 2px 4px rgba(0,0,0,.3)}
#face{width:160px;height:160px;background:#fff;border-radius:50%;margin:20px auto;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.3s}
#face.listen{background:#4CAF50;box-shadow:0 0 0 15px rgba(76,175,80,.3)}
#face.think{background:#FFC107}
#face.speak{background:#9C27B0;animation:pulse .4s infinite}
@keyframes pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
.eyes{display:flex;gap:25px}
.eye{width:22px;height:22px;background:#333;border-radius:50%}
#face.listen .eye,#face.think .eye,#face.speak .eye{background:#fff}
#status{font-size:1.3em;margin:15px 0}
#box{background:rgba(255,255,255,.15);backdrop-filter:blur(10px);padding:18px;border-radius:15px;min-height:70px}
.you{color:#FFE082}
.rob{color:#B2FF59;margin-top:8px}
.btns{display:flex;gap:10px;justify-content:center;margin-top:25px}
button{padding:15px 35px;font-size:1.1em;border:none;border-radius:30px;background:#fff;color:#667eea;cursor:pointer;font-weight:600}
button:hover{transform:scale(1.05)}
button.on{background:#f44336;color:#fff}
button.dance{background:#FF69B4;color:#fff}
</style>
</head>
<body>
<div class="c">
<h1>Robert</h1>
<div id="face"><div class="eyes"><div class="eye"></div><div class="eye"></div></div></div>
<div id="status">Toque para conversar</div>
<div id="box"><div class="you" id="you"></div><div class="rob" id="rob"></div></div>
<div class="btns">
<button id="btn" onclick="toggle()">Começar</button>
<button class="dance" onclick="danca()">Dancinha</button>
</div>
</div>
<script>
let on=0,sr,busy=false;

function toggle(){
    on=!on;
    document.getElementById('btn').textContent=on?'Parar':'Começar';
    document.getElementById('btn').className=on?'on':'';
    if(on)start();else stop();
}

function start(){
    const S=window.SpeechRecognition||window.webkitSpeechRecognition;
    sr=new S();
    sr.lang='pt-BR';
    sr.continuous=true;
    sr.interimResults=true;

    sr.onresult=async e=>{
        if(busy)return;
        let f='',interim='';
        for(let x=e.resultIndex;x<e.results.length;x++){
            if(e.results[x].isFinal)f+=e.results[x][0].transcript;
            else interim+=e.results[x][0].transcript;
        }
        document.getElementById('you').textContent=interim?'Você: '+interim:'';

        if(f&&f.trim()){
            busy=true;
            sr.stop();
            document.getElementById('you').textContent='Você: '+f;
            setUI('think','Pensando...');

            try{
                const r=await fetch('/chat?t='+encodeURIComponent(f));
                const d=await r.json();
                document.getElementById('rob').textContent='Robert: '+d.reply;
                setUI('speak','Falando...');
                // Pequeno delay para sincronizar com fim do áudio
                await delay(800);
            }catch(e){console.error(e)}

            if(on){
                busy=false;
                setUI('listen','Ouvindo...');
                sr.start();
            }
        }
    };

    sr.onerror=e=>{if(on&&!busy)setTimeout(()=>sr.start(),50)};
    sr.onend=()=>{if(on&&!busy)setTimeout(()=>sr.start(),50)};
    sr.start();
    setUI('listen','Ouvindo...');
    fetch('/listen');
}

function stop(){
    busy=false;
    if(sr)sr.stop();
    setUI('','Toque para conversar');
    fetch('/ready');
}

function setUI(cls,txt){
    document.getElementById('face').className=cls;
    document.getElementById('status').textContent=txt;
}

function delay(ms){return new Promise(r=>setTimeout(r,ms))}

async function danca(){
    if(busy)return;
    busy=true;
    if(sr)sr.stop();
    setUI('speak','Dançando!');
    await fetch('/dance');
    setUI('','Toque para conversar');
    busy=false;
    if(on){
        setUI('listen','Ouvindo...');
        sr.start();
    }
}

fetch('/ble');
</script>
</body>
</html>'''

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a):pass

    def do_GET(self):
        p=urlparse(self.path)
        if p.path=='/':
            self.send_response(200)
            self.send_header('Content-type','text/html')
            self.end_headers()
            self.wfile.write(HTML.encode())
        elif p.path=='/ble':
            ok=ble_run(ble_connect())
            set_color(2)
            self.json({'ok':ok})
        elif p.path=='/listen':
            set_color(3)
            self.json({'ok':True})
        elif p.path=='/ready':
            set_color(2)
            self.json({'ok':True})
        elif p.path=='/chat':
            t=parse_qs(p.query).get('t',[''])[0]
            reply=chat_speak(t)
            self.json({'reply':reply})
        elif p.path=='/dance':
            dance()
            self.json({'ok':True})
        else:
            self.send_response(404)
            self.end_headers()

    def json(self,d):
        self.send_response(200)
        self.send_header('Content-type','application/json')
        self.send_header('Access-Control-Allow-Origin','*')
        self.end_headers()
        self.wfile.write(json.dumps(d).encode())

def check_ble():
    """Verifica BLE a cada 10s"""
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

if __name__=='__main__':
    print("=" * 40)
    print("  Robert - Conversa Fluida")
    print("  http://localhost:8080")
    print("=" * 40)

    # Thread BLE checker
    threading.Thread(target=check_ble, daemon=True).start()

    # Servidor HTTP
    HTTPServer(('',PORT),Handler).serve_forever()
