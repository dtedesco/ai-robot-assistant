#!/usr/bin/env python3
"""
Scanner contínuo para detectar Robert_ble
Roda enquanto você usa o app no iPhone
"""
import asyncio
from bleak import BleakScanner
from datetime import datetime

# Endereços conhecidos
CLASSIC_ADDRESS = "F4:4E:FD:DE:BD:79"
BLE_ADDRESS = "086A5A8E-A325-A536-F7B9-80104F42500F"

found_devices = set()


def callback(device, adv_data):
    """Callback chamado para cada dispositivo encontrado"""
    name = device.name or "Unknown"
    addr = device.address

    # Filtra só dispositivos novos ou Robert
    key = f"{addr}"
    is_robert = "robert" in name.lower() or addr == BLE_ADDRESS

    if is_robert or key not in found_devices:
        found_devices.add(key)
        timestamp = datetime.now().strftime("%H:%M:%S")

        if is_robert:
            print(f"\n{'='*60}")
            print(f"[{timestamp}] *** ROBERT ENCONTRADO! ***")
            print(f"  Nome: {name}")
            print(f"  Endereço: {addr}")
            print(f"  RSSI: {adv_data.rssi}")
            print(f"  Service UUIDs: {adv_data.service_uuids}")
            print(f"  Manufacturer: {adv_data.manufacturer_data}")
            print(f"  Service Data: {adv_data.service_data}")
            print(f"{'='*60}\n")
        else:
            # Mostra outros dispositivos de forma resumida
            if adv_data.rssi > -70:  # Só dispositivos próximos
                print(f"[{timestamp}] {name}: {addr} (RSSI: {adv_data.rssi})")


async def scan_continuous():
    print("=" * 60)
    print("Scanner BLE Contínuo - Procurando Robert_ble")
    print("=" * 60)
    print()
    print("Instruções:")
    print("1. Abra o app Robertt no iPhone")
    print("2. Conecte ao robô pelo app")
    print("3. Envie comandos (cores, braços, etc)")
    print("4. Este scanner vai detectar o BLE advertising")
    print()
    print("Pressione Ctrl+C para parar")
    print()
    print("-" * 60)

    scanner = BleakScanner(callback)

    try:
        while True:
            await scanner.start()
            await asyncio.sleep(5)
            await scanner.stop()
            # Pequena pausa entre scans
            await asyncio.sleep(0.5)
    except KeyboardInterrupt:
        print("\nParando scanner...")
        await scanner.stop()


if __name__ == "__main__":
    asyncio.run(scan_continuous())
