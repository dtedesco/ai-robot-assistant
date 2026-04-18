#!/usr/bin/env python3
"""
Script de teste direto para Robert RS01
Conecta pelo endereço conhecido e testa comandos
"""
import asyncio
from bleak import BleakClient

# Endereço conhecido do Robert
ROBERT_ADDRESS = "086A5A8E-A325-A536-F7B9-80104F42500F"

# UUIDs
SERVICE_UUID = "0000ffc0-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffc2-0000-1000-8000-00805f9b34fb"

# Protocolo
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEPARATOR = bytes([0x01, 0x01])


def build_action_packet(action, speed_byte=8, speed_level=0, color=2, color_mode=0):
    """Constrói pacote de ação"""
    data = bytes([action, action, speed_byte, speed_level, color, color_mode, 2, 2])
    return HEADER + bytes([0x32, 0x01]) + data + SEPARATOR + FOOTER


def build_stop_packet():
    """Comando de parar"""
    return HEADER + bytes([0x0C]) + FOOTER


def on_notify(sender, data):
    """Callback de notificação"""
    if data and data != b'\x00' * len(data):
        print(f"[NOTIFY] {data.hex()}")


async def test_robot():
    print(f"Tentando conectar diretamente a: {ROBERT_ADDRESS}")
    print()

    try:
        async with BleakClient(ROBERT_ADDRESS, timeout=20.0) as client:
            print(f"Conectado: {client.is_connected}")
            print()

            # Lista serviços
            print("Serviços encontrados:")
            for service in client.services:
                print(f"  {service.uuid}")
                for char in service.characteristics:
                    props = ", ".join(char.properties)
                    print(f"    {char.uuid} [{props}]")
            print()

            # Habilita notificações
            try:
                await client.start_notify(NOTIFY_UUID, on_notify)
                print(f"Notificações habilitadas em {NOTIFY_UUID}")
            except Exception as e:
                print(f"Erro ao habilitar notificações: {e}")
            print()

            # Testes
            tests = [
                ("STOP", build_stop_packet()),
                ("COLOR 5 (red)", build_action_packet(77, speed_byte=8, color=5)),
                ("ARM 100", build_action_packet(100, speed_byte=8, color=2)),
                ("MOVE UP", build_action_packet(2, speed_byte=0xFF, color=2)),
                ("STOP MOVE", build_action_packet(77, speed_byte=8, color=2)),
                ("DANCE 10", build_action_packet(10, speed_byte=8, color=2)),
            ]

            for name, packet in tests:
                print(f"Enviando {name}:")
                print(f"  Packet: {packet.hex()}")
                print(f"  Bytes:  {list(packet)}")

                try:
                    await client.write_gatt_char(WRITE_UUID, packet, response=False)
                    print(f"  Enviado OK")
                except Exception as e:
                    print(f"  Erro: {e}")

                await asyncio.sleep(2)
                print()

            # Espera final
            print("Aguardando 5 segundos para respostas...")
            await asyncio.sleep(5)

            await client.stop_notify(NOTIFY_UUID)
            print("Teste concluído")

    except Exception as e:
        print(f"Erro de conexão: {e}")
        print()
        print("Se o erro for 'device not found', o robô pode não estar fazendo advertising.")
        print("Tente:")
        print("  1. Desligar e ligar o robô")
        print("  2. Abrir o app original primeiro, deixar conectar, fechar o app")
        print("  3. Rodar este script novamente")


if __name__ == "__main__":
    asyncio.run(test_robot())
