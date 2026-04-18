#!/usr/bin/env python3
"""
Robert RS01 - Chat com IA (Groq)
Conversa fluida com o robô usando Groq AI

Uso:
    export GROQ_API_KEY="sua_chave_aqui"
    python robert_chat.py
"""

import asyncio
import os
import subprocess
import threading
import time
from groq import Groq
from bleak import BleakClient

# Configuração
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
ROBERT_BLE_ADDR = "086A5A8E-A325-A536-F7B9-80104F42500F"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"

# Protocolo BLE
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEP = bytes([0x01, 0x01])

def build_packet(action, speed=8, color=2):
    data = bytes([action, action, speed, 0, color, 0, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEP + FOOTER

# Personalidade do Robert
SYSTEM_PROMPT = """Você é o Robert, um robô dançante fofo e divertido.
Você é amigável, engraçado e adora dançar e brincar.
Responda de forma curta e animada (máximo 2 frases).
Use linguagem informal e divertida.
Você pode fazer piadas e ser brincalhão.
Quando alguém pedir para dançar, fique animado!
Fale como uma criança feliz."""

class RobertChat:
    def __init__(self):
        self.client = Groq(api_key=GROQ_API_KEY)
        self.ble_client = None
        self.history = []
        self.color = 2  # azul
        self.is_speaking = False

    async def connect_ble(self):
        """Conecta ao robô via BLE"""
        try:
            print("Conectando ao Robert via BLE...")
            self.ble_client = BleakClient(ROBERT_BLE_ADDR, timeout=10)
            await self.ble_client.connect()
            print("BLE conectado!")
            return True
        except Exception as e:
            print(f"Erro BLE: {e}")
            return False

    async def move_arm(self, action=100):
        """Move o braço do robô"""
        if self.ble_client and self.ble_client.is_connected:
            try:
                packet = build_packet(action, color=self.color)
                await self.ble_client.write_gatt_char(WRITE_UUID, packet, response=False)
            except:
                pass

    async def animate_while_speaking(self):
        """Anima o robô enquanto fala"""
        actions = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110]
        i = 0
        while self.is_speaking:
            await self.move_arm(actions[i % len(actions)])
            i += 1
            await asyncio.sleep(0.8)

    def speak(self, text):
        """Fala o texto usando TTS"""
        self.is_speaking = True
        # Usa say em foreground para saber quando terminou
        subprocess.run(['say', '-v', 'Luciana', text], check=False)
        self.is_speaking = False

    def speak_async(self, text):
        """Fala em thread separada"""
        thread = threading.Thread(target=self.speak, args=(text,))
        thread.start()
        return thread

    def chat(self, user_message):
        """Envia mensagem para Groq e retorna resposta"""
        self.history.append({
            "role": "user",
            "content": user_message
        })

        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + self.history[-10:]

        try:
            response = self.client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                messages=messages,
                max_tokens=150,
                temperature=0.9
            )

            assistant_message = response.choices[0].message.content
            self.history.append({
                "role": "assistant",
                "content": assistant_message
            })

            return assistant_message

        except Exception as e:
            return f"Ops, deu um erro: {e}"

    async def run(self):
        """Loop principal do chat"""
        print("=" * 50)
        print("   Robert Chat - Conversa com IA")
        print("=" * 50)
        print()

        if not GROQ_API_KEY:
            print("ERRO: Configure a variável GROQ_API_KEY")
            print("  export GROQ_API_KEY='sua_chave_aqui'")
            print()
            print("Pegue sua chave em: https://console.groq.com/keys")
            return

        # Conecta BLE
        await self.connect_ble()

        print()
        print("Digite suas mensagens (ou 'sair' para encerrar)")
        print("Comandos especiais:")
        print("  /cor N    - Muda cor (1-7)")
        print("  /danca    - Robert dança")
        print()

        # Saudação inicial
        greeting = self.chat("Olá! Se apresente de forma animada!")
        print(f"Robert: {greeting}")

        speak_thread = self.speak_async(greeting)
        if self.ble_client:
            await self.animate_while_speaking()
        speak_thread.join()

        while True:
            try:
                user_input = input("\nVocê: ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nTchau!")
                break

            if not user_input:
                continue

            if user_input.lower() in ['sair', 'exit', 'quit']:
                farewell = self.chat("Diga tchau de forma fofa!")
                print(f"Robert: {farewell}")
                self.speak(farewell)
                break

            # Comandos especiais
            if user_input.startswith('/cor '):
                try:
                    self.color = int(user_input.split()[1])
                    print(f"Cor mudada para {self.color}")
                    await self.move_arm(77)
                except:
                    print("Uso: /cor N (1-7)")
                continue

            if user_input == '/danca':
                print("Robert: Eba, vou dançar!")
                self.speak_async("Eba, vou dançar!")
                for i in range(1, 20):
                    await self.move_arm(i)
                    await asyncio.sleep(0.5)
                continue

            # Chat normal
            response = self.chat(user_input)
            print(f"Robert: {response}")

            # Fala e anima simultaneamente
            speak_thread = self.speak_async(response)
            if self.ble_client and self.ble_client.is_connected:
                await self.animate_while_speaking()
            speak_thread.join()

        # Desconecta
        if self.ble_client:
            await self.ble_client.disconnect()


async def main():
    robert = RobertChat()
    await robert.run()


if __name__ == "__main__":
    asyncio.run(main())
