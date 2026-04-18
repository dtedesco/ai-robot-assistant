#!/usr/bin/env python3
"""
Robert RS01 Robot Controller
Controla o robô Robert RS01 via Bluetooth Low Energy

PROTOCOLO DESCOBERTO via engenharia reversa do APK cn.app.robert (v1.5.3)

Formato do pacote:
    [HEADER] [CMD] [COUNT] [ACTION_DATA...] [SEPARATOR] [FOOTER]

Header: AA AA CC
Footer: 55 55
Separator: 01 01 (apenas para CMD 0x32)

Comandos:
    0x32 - Ação (50 decimal) - precisa de ACTION_DATA
    0x0C - PARAR (12 decimal) - sem dados adicionais

ACTION_DATA (8 bytes para CMD 0x32):
    [action, action, speed_byte, speed_level, color, color_mode, 2, 2]

    action: Código da ação (1-110, 200-235)
    speed_byte: 8 para ações, 0xFF para movimento direcional
    speed_level: 0-3 (velocidade)
    color: 1=dark_blue, 2=blue, 3=green, 4=yellow, 5=red, 6=purple, 7=white
    color_mode: 0=ligado, 4=desligado

Tipos de ação:
    1-4: Movimento (down, up, left, right) - usa speed_byte=0xFF
    1-93: Ações combinadas (corpo todo)
    77: STOP movimento
    100-110: Ações de mão/braço
    200-235: Ações de perna

Uso:
    python robert_controller.py scan        # Escanear dispositivos
    python robert_controller.py stop        # Parar ação
    python robert_controller.py arm N       # Ação de braço (100-110)
    python robert_controller.py leg N       # Ação de perna (200-235)
    python robert_controller.py dance N     # Ação combinada (1-93)
    python robert_controller.py move DIR    # up/down/left/right
    python robert_controller.py color N     # Cor (1-7)
    python robert_controller.py interactive # Modo interativo
"""

import asyncio
import sys
from bleak import BleakClient, BleakScanner

# Configuração do Robert RS01
ROBERT_NAME = "Robert_ble"
SERVICE_UUID = "0000ffc0-0000-1000-8000-00805f9b34fb"
WRITE_CHAR_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR_UUID = "0000ffc2-0000-1000-8000-00805f9b34fb"

# Protocolo
HEADER = bytes([0xAA, 0xAA, 0xCC])
FOOTER = bytes([0x55, 0x55])
SEPARATOR = bytes([0x01, 0x01])

CMD_ACTION = 0x32  # 50 decimal
CMD_STOP = 0x0C    # 12 decimal

# Cores
COLORS = {
    'dark_blue': 1, 'darkblue': 1, 'azul_escuro': 1,
    'blue': 2, 'azul': 2,
    'green': 3, 'verde': 3,
    'yellow': 4, 'amarelo': 4,
    'red': 5, 'vermelho': 5,
    'purple': 6, 'roxo': 6,
    'white': 7, 'branco': 7
}

# Direções de movimento
DIRECTIONS = {
    'down': 1, 'baixo': 1,
    'up': 2, 'cima': 2,
    'left': 3, 'esquerda': 3,
    'right': 4, 'direita': 4
}


def build_action_packet(action: int, speed_byte: int = 8, speed_level: int = 0,
                        color: int = 2, color_mode: int = 0) -> bytes:
    """
    Constrói pacote de ação no formato do protocolo Robert.

    Args:
        action: Código da ação (1-110, 200-235)
        speed_byte: 8 para ações normais, 0xFF para movimento direcional
        speed_level: Nível de velocidade (0-3)
        color: Cor do LED (1-7)
        color_mode: 0=ligado, 4=desligado
    """
    # 8 bytes de dados da ação
    action_data = bytes([
        action,      # f2092b - action
        action,      # f2093c - action (repetido)
        speed_byte,  # f2094d - speed_byte
        speed_level, # f2095e - speed_level
        color,       # f2096f - color
        color_mode,  # f2097g - color_mode
        2,           # f2098h - fixo
        2            # f2099i - fixo
    ])

    # Pacote completo
    packet = HEADER + bytes([CMD_ACTION, 0x01]) + action_data + SEPARATOR + FOOTER
    return packet


def build_stop_packet() -> bytes:
    """Comando para parar a ação atual"""
    return HEADER + bytes([CMD_STOP]) + FOOTER


def notification_handler(sender, data):
    """Handler para notificações recebidas do robô"""
    hex_str = data.hex()
    if hex_str != "00" * len(data):  # Ignora respostas vazias
        print(f"[RESP] {hex_str}")


async def find_robert(address=None):
    """Encontra o dispositivo Robert_ble"""
    # Se endereço fornecido, usa direto
    if address:
        print(f"Usando endereço direto: {address}")
        return address

    print(f"Procurando {ROBERT_NAME} por 15 segundos...")

    # Primeiro tenta por nome
    device = await BleakScanner.find_device_by_name(ROBERT_NAME, timeout=15.0)
    if device:
        print(f"Encontrado: {device.name} ({device.address})")
        return device

    # Se não encontrou, escaneia todos e procura por "robert"
    print("Não encontrado por nome. Escaneando todos os dispositivos...")
    devices = await BleakScanner.discover(timeout=10.0, return_adv=True)
    for addr, (dev, adv) in devices.items():
        name = dev.name or ""
        if "robert" in name.lower():
            print(f"Encontrado: {dev.name} ({dev.address})")
            return dev

    print(f"Dispositivo {ROBERT_NAME} não encontrado!")
    print("Dica: O robô precisa estar ligado. A música NÃO precisa estar tocando para BLE.")
    print("      Tente desligar e ligar o robô novamente.")
    return None


async def send_command(packet: bytes, description: str = ""):
    """Envia um comando para o robô"""
    device = await find_robert()
    if not device:
        return

    print(f"Conectando a {device.name}...")
    async with BleakClient(device) as client:
        await client.start_notify(NOTIFY_CHAR_UUID, notification_handler)

        print(f"Enviando: {description}")
        print(f"Packet: {packet.hex()}")
        print(f"Bytes:  {list(packet)}")
        await client.write_gatt_char(WRITE_CHAR_UUID, packet)
        print("Enviado!")

        await asyncio.sleep(1)
        await client.stop_notify(NOTIFY_CHAR_UUID)


async def cmd_stop():
    """Comando: Parar"""
    packet = build_stop_packet()
    await send_command(packet, "STOP")


async def cmd_arm(action_num: int, color: int = 2):
    """Comando: Ação de braço (100-110)"""
    if action_num < 100 or action_num > 110:
        print("Ações de braço: 100-110")
        return
    packet = build_action_packet(action_num, speed_byte=8, color=color)
    await send_command(packet, f"ARM action {action_num}")


async def cmd_leg(action_num: int, color: int = 2):
    """Comando: Ação de perna (200-235)"""
    if action_num < 200 or action_num > 235:
        print("Ações de perna: 200-235")
        return
    packet = build_action_packet(action_num, speed_byte=8, color=color)
    await send_command(packet, f"LEG action {action_num}")


async def cmd_dance(action_num: int, color: int = 2):
    """Comando: Ação combinada (1-93)"""
    if action_num < 1 or action_num > 93:
        print("Ações combinadas: 1-93")
        return
    packet = build_action_packet(action_num, speed_byte=8, color=color)
    await send_command(packet, f"DANCE action {action_num}")


async def cmd_move(direction: str, color: int = 2):
    """Comando: Movimento direcional"""
    dir_code = DIRECTIONS.get(direction.lower())
    if dir_code is None:
        print(f"Direção inválida: {direction}")
        print(f"Direções válidas: {list(DIRECTIONS.keys())}")
        return
    # Movimento usa speed_byte=0xFF
    packet = build_action_packet(dir_code, speed_byte=0xFF, color=color)
    await send_command(packet, f"MOVE {direction}")


async def cmd_color(color: int):
    """Comando: Definir cor do LED (envia ação 77=stop com cor)"""
    if color < 1 or color > 7:
        print("Cores: 1=dark_blue, 2=blue, 3=green, 4=yellow, 5=red, 6=purple, 7=white")
        return
    packet = build_action_packet(77, speed_byte=8, color=color)
    await send_command(packet, f"COLOR {color}")


# Endereço conhecido do Robert (descoberto anteriormente)
ROBERT_ADDRESS = "086A5A8E-A325-A536-F7B9-80104F42500F"


async def scan_devices():
    """Escaneia dispositivos BLE"""
    print("Escaneando dispositivos BLE por 10 segundos...")
    devices = await BleakScanner.discover(timeout=10.0, return_adv=True)

    print(f"\nEncontrados {len(devices)} dispositivos:\n")
    for address, (device, adv) in devices.items():
        name = device.name or "Unknown"
        marker = " <-- ROBERT" if "robert" in name.lower() else ""
        print(f"  {name}: {address} (RSSI: {adv.rssi}){marker}")


async def interactive_mode():
    """Modo interativo para testar comandos"""
    device = await find_robert()
    if not device:
        return

    print(f"Conectando a {device.name}...")

    # Estado atual
    current_color = 2  # blue
    current_speed = 0

    async with BleakClient(device) as client:
        # Lista serviços e características
        print("\nServiços disponíveis:")
        for service in client.services:
            print(f"  Service: {service.uuid}")
            for char in service.characteristics:
                props = ",".join(char.properties)
                print(f"    Char: {char.uuid} [{props}]")
        print()

        # Habilita notificações
        try:
            await client.start_notify(NOTIFY_CHAR_UUID, notification_handler)
            print("Notificações habilitadas em FFC2")
        except Exception as e:
            print(f"Aviso: Não foi possível habilitar notificações: {e}")

        print("\n" + "=" * 60)
        print("MODO INTERATIVO - Robert RS01 Controller")
        print("=" * 60)
        print("\nComandos disponíveis:")
        print("  arm N          - Ação de braço (100-110)")
        print("  leg N          - Ação de perna (200-235)")
        print("  dance N        - Ação combinada (1-93)")
        print("  move DIR       - Movimento (up/down/left/right)")
        print("  stop           - Parar ação atual")
        print("  color N        - Definir cor (1-7)")
        print("  hex AABBCC...  - Enviar bytes raw")
        print("  test           - Testar pacote padrão")
        print("  quit           - Sair")
        print()
        print(f"Cor atual: {current_color}")
        print()

        while True:
            try:
                cmd = input("robert> ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nSaindo...")
                break

            if not cmd:
                continue

            parts = cmd.split()
            action = parts[0].lower()

            try:
                if action in ("quit", "exit", "q"):
                    print("Desconectando...")
                    break

                elif action == "stop":
                    packet = build_stop_packet()
                    print(f"Enviando STOP: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "arm":
                    if len(parts) < 2:
                        print("Uso: arm N (100-110)")
                        continue
                    n = int(parts[1])
                    if n < 100 or n > 110:
                        print("Ações de braço: 100-110")
                        continue
                    packet = build_action_packet(n, speed_byte=8, color=current_color)
                    print(f"Enviando ARM {n}: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "leg":
                    if len(parts) < 2:
                        print("Uso: leg N (200-235)")
                        continue
                    n = int(parts[1])
                    if n < 200 or n > 235:
                        print("Ações de perna: 200-235")
                        continue
                    packet = build_action_packet(n, speed_byte=8, color=current_color)
                    print(f"Enviando LEG {n}: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "dance":
                    if len(parts) < 2:
                        print("Uso: dance N (1-93)")
                        continue
                    n = int(parts[1])
                    if n < 1 or n > 93:
                        print("Ações combinadas: 1-93")
                        continue
                    packet = build_action_packet(n, speed_byte=8, color=current_color)
                    print(f"Enviando DANCE {n}: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "move":
                    if len(parts) < 2:
                        print("Uso: move DIR (up/down/left/right)")
                        continue
                    direction = parts[1].lower()
                    dir_code = DIRECTIONS.get(direction)
                    if dir_code is None:
                        print(f"Direção inválida. Use: up, down, left, right")
                        continue
                    # Movimento usa speed_byte=0xFF
                    packet = build_action_packet(dir_code, speed_byte=0xFF, color=current_color)
                    print(f"Enviando MOVE {direction}: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "color":
                    if len(parts) < 2:
                        print("Uso: color N (1-7)")
                        print("  1=dark_blue, 2=blue, 3=green, 4=yellow, 5=red, 6=purple, 7=white")
                        continue
                    c = int(parts[1])
                    if c < 1 or c > 7:
                        print("Cor deve ser 1-7")
                        continue
                    current_color = c
                    # Envia ação 77 (stop) com a nova cor para atualizar
                    packet = build_action_packet(77, speed_byte=8, color=current_color)
                    print(f"Cor definida para {c}: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "hex":
                    if len(parts) < 2:
                        print("Uso: hex AABBCC...")
                        continue
                    data = bytes.fromhex(parts[1])
                    print(f"Enviando RAW: {data.hex()}")
                    print(f"Bytes: {list(data)}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, data)
                    print("OK")

                elif action == "test":
                    # Teste com ação 100 (primeiro braço)
                    packet = build_action_packet(100, speed_byte=8, color=2)
                    print(f"Enviando TEST (arm 100): {packet.hex()}")
                    print(f"Bytes: {list(packet)}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "testwr":
                    # Teste com write com resposta
                    packet = build_action_packet(100, speed_byte=8, color=2)
                    print(f"Enviando TEST com response=True: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet, response=True)
                    print("OK")

                elif action == "testnr":
                    # Teste com write sem resposta
                    packet = build_action_packet(100, speed_byte=8, color=2)
                    print(f"Enviando TEST com response=False: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet, response=False)
                    print("OK")

                elif action == "raw":
                    # Testar pacote exato do app
                    # Movimento para cima: action=2, speed_byte=0xFF
                    packet = build_action_packet(2, speed_byte=0xFF, color=current_color)
                    print(f"Enviando MOVE UP: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    await asyncio.sleep(1)
                    # Stop movimento: action=77, speed_byte=8
                    packet = build_action_packet(77, speed_byte=8, color=current_color)
                    print(f"Enviando STOP: {packet.hex()}")
                    await client.write_gatt_char(WRITE_CHAR_UUID, packet)
                    print("OK")

                elif action == "debug":
                    # Lê a característica para debug
                    try:
                        data = await client.read_gatt_char(WRITE_CHAR_UUID)
                        print(f"FFC1 data: {data.hex()}")
                    except Exception as e:
                        print(f"Erro ao ler: {e}")
                    try:
                        data = await client.read_gatt_char(NOTIFY_CHAR_UUID)
                        print(f"FFC2 data: {data.hex()}")
                    except Exception as e:
                        print(f"Erro ao ler FFC2: {e}")

                else:
                    print(f"Comando desconhecido: {action}")
                    print("Digite 'help' para ver comandos ou 'quit' para sair")

                await asyncio.sleep(0.3)

            except ValueError as e:
                print(f"Erro de valor: {e}")
            except Exception as e:
                print(f"Erro: {e}")

        await client.stop_notify(NOTIFY_CHAR_UUID)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    command = sys.argv[1].lower()

    if command == "scan":
        asyncio.run(scan_devices())

    elif command == "stop":
        asyncio.run(cmd_stop())

    elif command == "arm":
        if len(sys.argv) < 3:
            print("Uso: robert_controller.py arm N (100-110)")
            return
        asyncio.run(cmd_arm(int(sys.argv[2])))

    elif command == "leg":
        if len(sys.argv) < 3:
            print("Uso: robert_controller.py leg N (200-235)")
            return
        asyncio.run(cmd_leg(int(sys.argv[2])))

    elif command == "dance":
        if len(sys.argv) < 3:
            print("Uso: robert_controller.py dance N (1-93)")
            return
        asyncio.run(cmd_dance(int(sys.argv[2])))

    elif command == "move":
        if len(sys.argv) < 3:
            print("Uso: robert_controller.py move DIR (up/down/left/right)")
            return
        asyncio.run(cmd_move(sys.argv[2]))

    elif command == "color":
        if len(sys.argv) < 3:
            print("Uso: robert_controller.py color N (1-7)")
            return
        asyncio.run(cmd_color(int(sys.argv[2])))

    elif command == "interactive" or command == "i":
        asyncio.run(interactive_mode())

    else:
        print(f"Comando desconhecido: {command}")
        print(__doc__)


if __name__ == "__main__":
    main()
