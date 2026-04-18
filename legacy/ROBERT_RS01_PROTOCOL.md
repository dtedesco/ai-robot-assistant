# Robert RS01 - Protocolo BLE e Controle via PC

Documentação do protocolo Bluetooth Low Energy do robô dançante Robert RS01, obtido via engenharia reversa do APK `cn.app.robert` (Robertt v1.5.3).

## Como Conectar (Passo a Passo)

O Robert usa **duas conexões Bluetooth simultâneas**:
- **Bluetooth Classic (A2DP/HFP)** - Para áudio (tocar som e microfone)
- **Bluetooth Low Energy (BLE)** - Para comandos (braços, pernas, cores)

### Passo 1: Desconectar o App do Celular

⚠️ **IMPORTANTE**: A conexão BLE é exclusiva. Se o app do celular estiver conectado, o PC não consegue conectar.

- Feche o app Robertt no celular
- Ou desligue o Bluetooth do celular

### Passo 2: Ligar o Robô

- Ligue o Robert RS01
- Aguarde ele inicializar (olhos acendem)

### Passo 3: Conectar Bluetooth Classic (Áudio)

```bash
# Conectar ao Robert para áudio
blueutil --connect f4-4e-fd-de-bd-79

# Verificar se conectou
blueutil --connected

# Definir como saída de áudio
SwitchAudioSource -s "Robert" -t output
```

### Passo 4: Conectar BLE (Comandos)

```bash
# Ativar ambiente Python
source /tmp/ble_env/bin/activate

# Escanear para encontrar Robert_ble
python robert_controller.py scan

# Conectar e controlar
python robert_controller.py interactive
```

### Passo 5: Usar!

Agora você pode:
- Enviar comandos BLE (braços, pernas, cores)
- Tocar áudio (`say "texto"` ou `afplay arquivo.mp3`)
- Gravar do microfone
- Tudo ao mesmo tempo!

### Script de Conexão Rápida

```bash
#!/bin/bash
# robert_connect.sh - Conecta ao Robert

echo "Conectando Bluetooth Classic (áudio)..."
blueutil --connect f4-4e-fd-de-bd-79
sleep 2

echo "Definindo como saída de áudio..."
SwitchAudioSource -s "Robert" -t output

echo "Escaneando BLE..."
/tmp/ble_env/bin/python3.12 robert_controller.py scan

echo ""
echo "Pronto! Use: /tmp/ble_env/bin/python3.12 robert_controller.py interactive"
```

## Requisitos

- Python 3.12+
- Biblioteca `bleak` para BLE
- macOS, Linux ou Windows com Bluetooth

### Instalação

```bash
# Criar ambiente virtual
python3.12 -m venv /tmp/ble_env

# Instalar bleak
/tmp/ble_env/bin/pip install bleak
```

## Informações do Dispositivo

| Propriedade | Valor |
|-------------|-------|
| Nome BLE | `Robert_ble` |
| Endereço BLE (exemplo) | `086A5A8E-A325-A536-F7B9-80104F42500F` |
| Endereço Classic (áudio) | `F4:4E:FD:DE:BD:79` |
| Service UUID | `0000ffc0-0000-1000-8000-00805f9b34fb` |
| Write Characteristic | `0000ffc1-0000-1000-8000-00805f9b34fb` |
| Notify Characteristic | `0000ffc2-0000-1000-8000-00805f9b34fb` |

## Protocolo de Comunicação

### Estrutura do Pacote

```
[HEADER] [CMD] [COUNT] [DATA...] [SEPARATOR] [FOOTER]
```

| Campo | Bytes | Valor |
|-------|-------|-------|
| Header | 3 | `AA AA CC` |
| Comando | 1 | `32` (ação) ou `0C` (stop) |
| Count | 1 | Número de ações (geralmente `01`) |
| Data | 8 | Dados da ação (ver abaixo) |
| Separator | 2 | `01 01` (apenas para cmd `32`) |
| Footer | 2 | `55 55` |

### Dados da Ação (8 bytes)

```
[action, action, speed_byte, speed_level, color, color_mode, 2, 2]
```

| Byte | Nome | Descrição |
|------|------|-----------|
| 0-1 | action | Código da ação (repetido) |
| 2 | speed_byte | `8` para ações, `255` (0xFF) para movimento |
| 3 | speed_level | Velocidade: 0-3 |
| 4 | color | Cor do LED: 1-7 |
| 5 | color_mode | `0` = olhos ligados, `4` = desligados |
| 6-7 | fixo | Sempre `2, 2` |

### Cores Disponíveis

| Valor | Cor |
|-------|-----|
| 1 | Azul escuro |
| 2 | Azul |
| 3 | Verde |
| 4 | Amarelo |
| 5 | Vermelho |
| 6 | Roxo |
| 7 | Branco |

### Códigos de Ação

| Range | Tipo | Descrição |
|-------|------|-----------|
| 1-4 | Movimento | 1=baixo, 2=cima, 3=esquerda, 4=direita |
| 1-93 | Dança | Ações combinadas (corpo todo) |
| 77 | Stop | Para o movimento atual |
| 100-110 | Braços | Movimentos dos braços |
| 200-235 | Pernas | Movimentos das pernas |

## Exemplos de Pacotes

### Mover braço (ação 100)
```
AA AA CC 32 01 64 64 08 00 02 00 02 02 01 01 55 55
```

### Mudar cor para vermelho
```
AA AA CC 32 01 4D 4D 08 00 05 00 02 02 01 01 55 55
```
(action=77/stop, color=5/vermelho)

### Movimento para cima
```
AA AA CC 32 01 02 02 FF 00 02 00 02 02 01 01 55 55
```
(action=2, speed_byte=255)

### Comando STOP
```
AA AA CC 0C 55 55
```

## Como Conectar

### 1. Escanear dispositivos

```bash
/tmp/ble_env/bin/python3.12 robert_controller.py scan
```

### 2. Conectar e controlar

```bash
/tmp/ble_env/bin/python3.12 robert_controller.py interactive
```

### Comandos no modo interativo

```
arm N       - Movimento de braço (100-110)
leg N       - Movimento de perna (200-235)
dance N     - Dança combinada (1-93)
color N     - Mudar cor (1-7)
move DIR    - Movimento (up/down/left/right)
stop        - Parar
quit        - Sair
```

## Código Python Mínimo

```python
import asyncio
from bleak import BleakClient

ADDR = '086A5A8E-A325-A536-F7B9-80104F42500F'
WRITE = '0000ffc1-0000-1000-8000-00805f9b34fb'

def build_packet(action, speed=8, color=2):
    header = bytes([0xAA, 0xAA, 0xCC])
    footer = bytes([0x55, 0x55])
    sep = bytes([0x01, 0x01])
    data = bytes([action, action, speed, 0, color, 0, 2, 2])
    return header + bytes([0x32, 0x01]) + data + sep + footer

async def send_command(action):
    async with BleakClient(ADDR) as client:
        await client.write_gatt_char(WRITE, build_packet(action), response=False)

# Exemplo: mover braço 100
asyncio.run(send_command(100))
```

## Troubleshooting

### "Device not found"

1. O robô precisa estar **ligado**
2. O app do celular deve estar **desconectado** (conexão BLE é exclusiva)
3. Escaneie novamente: `python robert_controller.py scan`

### Comandos não funcionam

1. Verifique se está conectado via BLE (não Bluetooth Classic)
2. O robô aparece como `Robert_ble`, não apenas `Robert`
3. Tente desligar e ligar o robô

### Conexão cai frequentemente

- O robô pode ter timeout de inatividade
- Envie comandos periodicamente para manter conexão

## Áudio - Tocar Som e Microfone

O Robert também funciona como alto-falante e microfone Bluetooth (perfil HFP/A2DP).

### Conectar Bluetooth Classic (Áudio)

```bash
# Instalar ferramentas
brew install blueutil switchaudio-osx

# Conectar ao Robert
blueutil --connect f4-4e-fd-de-bd-79

# Verificar conexão
blueutil --connected
```

### Tocar Som no Robert

```bash
# Definir Robert como saída de áudio
SwitchAudioSource -s "Robert" -t output

# Falar texto
say -v Luciana "Olá, eu sou o Robert"

# Tocar arquivo de áudio
afplay musica.mp3

# Voltar para alto-falantes do Mac
SwitchAudioSource -s "Alto-falantes (MacBook Pro)" -t output
```

### Gravar do Microfone do Robert

```bash
# Definir Robert como entrada de áudio
SwitchAudioSource -s "Robert" -t input

# Gravar 10 segundos
ffmpeg -f avfoundation -i ":Robert" -t 10 gravacao.wav

# Voltar para microfone do Mac
SwitchAudioSource -s "Microfone (MacBook Pro)" -t input
```

### Falar e Mover ao Mesmo Tempo

```python
import asyncio
from bleak import BleakClient
import subprocess

ADDR = '086A5A8E-A325-A536-F7B9-80104F42500F'
WRITE = '0000ffc1-0000-1000-8000-00805f9b34fb'

def build(action, speed=8, color=5):
    header = bytes([0xAA, 0xAA, 0xCC])
    footer = bytes([0x55, 0x55])
    sep = bytes([0x01, 0x01])
    data = bytes([action, action, speed, 0, color, 0, 2, 2])
    return header + bytes([0x32, 0x01]) + data + sep + footer

async def falar_e_mover():
    async with BleakClient(ADDR, timeout=15) as client:
        # Inicia fala em background (Bluetooth Classic)
        subprocess.Popen(['say', '-v', 'Luciana', 'Olá! Estou mexendo meus braços!'])

        # Mexe os braços via BLE
        for i in range(100, 108):
            await client.write_gatt_char(WRITE, build(i, color=5), response=False)
            await asyncio.sleep(1)

asyncio.run(falar_e_mover())
```

### Vozes Disponíveis (Português)

```bash
# Listar vozes em português
say -v '?' | grep pt

# Vozes comuns:
# - Luciana (pt_BR feminina)
# - Felipe (pt_BR masculina)
# - Joana (pt_PT feminina)
```

## Arquivos

- `robert_controller.py` - Script principal de controle
- `robert_test.py` - Script de teste de conexão
- `ROBERT_RS01_PROTOCOL.md` - Esta documentação

## Créditos

Protocolo descoberto via engenharia reversa do APK cn.app.robert usando JADX.
