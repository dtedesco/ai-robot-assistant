#!/usr/bin/env python3
"""
Robert RS01 - Versão Otimizada
Usa streaming para resposta mais rápida
"""

import asyncio
import json
import os
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
from openai import OpenAI
from bleak import BleakClient

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
PORT = 8080

client = OpenAI(api_key=OPENAI_API_KEY)
ble_client = None
is_speaking = False
color = 3

HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def build_packet(action, c=2):
    data = bytes([action, action, 8, 0, c, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

def run_ble(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()

async def connect_ble():
    global ble_client
    try:
        ble_client = BleakClient(ROBERT_BLE_ADDR, timeout=10)
        await ble_client.connect()
        return True
    except:
        return False

async def send_cmd(action):
    global ble_client
    try:
        if ble_client and ble_client.is_connected:
            await ble_client.write_gatt_char(WRITE_UUID, build_packet(action, color), response=False)
    except:
        pass

def animate():
    global is_speaking
    i = 0
    while is_speaking:
        run_ble(send_cmd(100 + (i % 8)))
        run_ble(send_cmd(200 + (i % 8)))
        i += 1
        import time
        time.sleep(0.35)

def chat_and_speak(text):
    global is_speaking, color

    # Chat rápido
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Você é Robert, robô amigo. Fale em 1 frase curta."},
            {"role": "user", "content": text}
        ],
        max_tokens=40
    )
    reply = response.choices[0].message.content

    # Cor verde (feliz)
    color = 3
    run_ble(send_cmd(77))

    # TTS rápido
    tts = client.audio.speech.create(model="tts-1", voice="nova", input=reply)
    with open('/tmp/r.mp3', 'wb') as f:
        f.write(tts.content)

    # Falar + animar
    is_speaking = True
    anim = threading.Thread(target=animate)
    anim.start()
    subprocess.run(['afplay', '/tmp/r.mp3'])
    is_speaking = False
    anim.join()

    # Cor azul (normal)
    color = 2
    run_ble(send_cmd(77))

    return reply

HTML = '''<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Robert</title>
    <style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:system-ui;background:#1a1a2e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}
        .c{text-align:center;padding:20px}
        h1{font-size:2em;margin-bottom:20px}
        #r{width:150px;height:150px;background:#fff;border-radius:50%;margin:20px auto;display:flex;align-items:center;justify-content:center;cursor:pointer}
        #r.on{background:#4CAF50;animation:p 1s infinite}
        #r.talk{background:#2196F3;animation:p .3s infinite}
        @keyframes p{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
        .e{display:flex;gap:20px}
        .e div{width:20px;height:20px;background:#333;border-radius:50%}
        #r.on .e div,#r.talk .e div{background:#fff}
        #s{font-size:1.2em;margin:15px 0;min-height:25px}
        #t{background:rgba(255,255,255,.1);padding:15px;border-radius:10px;min-height:60px;max-width:350px;margin:0 auto}
        .u{color:#FFD54F}.b{color:#81C784;margin-top:8px}
        button{margin-top:20px;padding:12px 35px;font-size:1.1em;border:none;border-radius:25px;background:#4CAF50;color:#fff;cursor:pointer}
    </style>
</head>
<body>
<div class="c">
    <h1>Robert</h1>
    <div id="r"><div class="e"><div></div><div></div></div></div>
    <div id="s">Toque para conversar</div>
    <div id="t"><div class="u" id="u"></div><div class="b" id="b"></div></div>
    <button onclick="go()">Iniciar</button>
</div>
<script>
let on=false,rec=null;

function go(){
    if(on){stop();return}
    on=true;
    document.querySelector('button').textContent='Parar';

    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    rec=new SR();
    rec.lang='pt-BR';
    rec.continuous=true;
    rec.interimResults=true;

    rec.onresult=async e=>{
        let f='',i='';
        for(let x=e.resultIndex;x<e.results.length;x++){
            if(e.results[x].isFinal)f+=e.results[x][0].transcript;
            else i+=e.results[x][0].transcript;
        }
        if(i)document.getElementById('u').textContent='Você: '+i;
        if(f){
            rec.stop();
            document.getElementById('u').textContent='Você: '+f;
            document.getElementById('r').className='talk';
            document.getElementById('s').textContent='Pensando...';

            const r=await fetch('/chat?t='+encodeURIComponent(f));
            const d=await r.json();
            document.getElementById('b').textContent='Robert: '+d.reply;
            document.getElementById('s').textContent='Falando...';

            // Espera fala terminar
            await new Promise(x=>setTimeout(x,d.reply.length*65));

            if(on){
                document.getElementById('r').className='on';
                document.getElementById('s').textContent='Ouvindo...';
                rec.start();
            }
        }
    };
    rec.onend=()=>{if(on)rec.start()};
    rec.start();
    document.getElementById('r').className='on';
    document.getElementById('s').textContent='Ouvindo...';
}

function stop(){
    on=false;
    if(rec)rec.stop();
    document.getElementById('r').className='';
    document.getElementById('s').textContent='Toque para conversar';
    document.querySelector('button').textContent='Iniciar';
}

fetch('/ble');
</script>
</body>
</html>'''

class H(BaseHTTPRequestHandler):
    def log_message(self,*a):pass

    def do_GET(self):
        p=urlparse(self.path)
        if p.path=='/':
            self.send_response(200)
            self.send_header('Content-type','text/html')
            self.end_headers()
            self.wfile.write(HTML.encode())
        elif p.path=='/ble':
            ok=run_ble(connect_ble())
            self.send_response(200)
            self.send_header('Content-type','application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok':ok}).encode())
        elif p.path=='/chat':
            q=parse_qs(p.query)
            t=q.get('t',[''])[0]
            reply=chat_and_speak(t)
            self.send_response(200)
            self.send_header('Content-type','application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'reply':reply}).encode())

print("Robert Fast - http://localhost:8080")
HTTPServer(('',PORT),H).serve_forever()
