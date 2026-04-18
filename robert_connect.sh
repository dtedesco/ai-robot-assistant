#!/bin/bash
# robert_connect.sh - Conecta ao Robert RS01
# Uso: ./robert_connect.sh

echo "========================================"
echo "   Robert RS01 - Conexão Rápida"
echo "========================================"
echo ""

# Endereços
BT_CLASSIC="f4-4e-fd-de-bd-79"
PYTHON="/tmp/ble_env/bin/python3.12"
CONTROLLER="$(dirname "$0")/robert_controller.py"

# Passo 1: Bluetooth Classic (áudio)
echo "[1/3] Conectando Bluetooth Classic (áudio)..."
blueutil --connect $BT_CLASSIC
sleep 2

if blueutil --connected | grep -q $BT_CLASSIC; then
    echo "      ✓ Áudio conectado!"
else
    echo "      ✗ Falha na conexão de áudio"
fi

# Passo 2: Definir como saída de áudio
echo ""
echo "[2/3] Configurando saída de áudio..."
SwitchAudioSource -s "Robert" -t output 2>/dev/null && echo "      ✓ Saída de áudio: Robert" || echo "      ✗ Falha ao definir saída"

# Passo 3: Escanear BLE
echo ""
echo "[3/3] Escaneando BLE..."
$PYTHON -c "
import asyncio
from bleak import BleakScanner

async def scan():
    device = await BleakScanner.find_device_by_name('Robert_ble', timeout=10)
    if device:
        print(f'      ✓ BLE encontrado: {device.address}')
    else:
        print('      ✗ Robert_ble não encontrado')
        print('        Dica: Feche o app do celular e tente novamente')

asyncio.run(scan())
"

echo ""
echo "========================================"
echo "   Conexão concluída!"
echo "========================================"
echo ""
echo "Comandos disponíveis:"
echo ""
echo "  # Modo interativo (controle manual)"
echo "  $PYTHON $CONTROLLER interactive"
echo ""
echo "  # Comandos diretos"
echo "  $PYTHON $CONTROLLER arm 100      # Mover braço"
echo "  $PYTHON $CONTROLLER dance 50     # Dançar"
echo "  $PYTHON $CONTROLLER color 5      # Cor vermelha"
echo ""
echo "  # Falar"
echo "  say -v Luciana 'Olá mundo'"
echo ""
