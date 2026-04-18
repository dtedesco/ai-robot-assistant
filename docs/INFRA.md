# Infraestrutura GCP — projeto `lykke-food`

Deploy em produção do admin (API + Web) rodando no Google Cloud Platform,
projeto `lykke-food` (number `570741484867`). Bridge continua no Mac/Pi do
cliente, apontando para a API via WebSocket.

## Topologia

```
           Internet
              │
      ┌───────┴─────────────────────────────────┐
      │                                         │
  web (Cloud Run)                         api (Cloud Run)
  us-central1                             us-central1
  nginx → /api/*, /ws/* proxy ─────────▶  Fastify + Prisma + WS
  serve dist React                        │
                                          │ Unix socket
                                          ▼
                              Cloud SQL Postgres 16
                              lykke-food:us-central1:lykke-db
```

O bridge (Node + browser Web Audio) estabelece `ws://<api>/ws/bridge` com
token, consome `welcome`, e serve UI local em `:3100` para o mic/speaker
do usuário.

## Recursos criados

| Recurso | Nome | Região | Tier / Config | Custo estimado |
|---|---|---|---|---|
| Cloud SQL | `lykke-db` | `us-central1` | Postgres 16 · `db-f1-micro` · 10 GB HDD · sem backup · enterprise | ~**US$10/mês** |
| Artifact Registry | `lykke-registry` | `us-central1` | Docker format | centavos |
| Cloud Run | `api` | `us-central1` | cpu=1, memory=512Mi, min=0, max=3 | grátis até ~2M req/mês |
| Cloud Run | `web` | `us-central1` | cpu=1, memory=256Mi, min=0, max=3 | grátis até ~2M req/mês |
| Secret Manager | `openai-api-key`, `jwt-secret`, `admin-password`, `db-password` | — | auto replicação | centavos |
| APIs habilitadas | `run`, `artifactregistry`, `sqladmin`, `cloudbuild`, `secretmanager` | — | — | — |

## Conta que administra o projeto

- `diogotedesco89@gmail.com` (proprietário do projeto GCP)
- Trocar conta ativa: `gcloud config set account diogotedesco89@gmail.com`
- ADC configurado para Cloud SQL Auth Proxy:
  `gcloud auth application-default login`

## Secrets

Todos os secrets vivem em **Secret Manager**. Acesso:

```bash
gcloud secrets versions access latest --secret=openai-api-key
```

| Secret | Origem | Uso |
|---|---|---|
| `openai-api-key` | `.env` local (mesma chave OpenAI usada em dev) | API proxya pro Realtime |
| `jwt-secret` | `openssl rand -hex 32` na primeira deploy | assinatura JWT |
| `admin-password` | `openssl rand -hex 12` na primeira deploy | password do admin `admin@lykke.food` — guarde esta |
| `db-password` | `openssl rand -hex 16` na primeira deploy | root do Postgres |

> ⚠️ A senha do admin foi gerada aleatoriamente e está apenas no Secret
> Manager. Anote quando for feita a primeira bootstrap.

A service account `570741484867-compute@developer.gserviceaccount.com`
tem `roles/secretmanager.secretAccessor` nos quatro secrets.

## Como refazer o deploy (de zero)

### 1. Pré-requisitos locais

```bash
brew install --cask google-cloud-sdk  # ou similar
gcloud auth login                      # navegador
gcloud auth application-default login  # pra cloud-sql-proxy
gcloud config set project lykke-food
```

### 2. Habilitar APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  cloudbuild.googleapis.com \
  secretmanager.googleapis.com
```

### 3. Criar infra

```bash
DB_PASS=$(openssl rand -hex 16)
JWT=$(openssl rand -hex 32)
ADMIN_PW=$(openssl rand -hex 12)

gcloud artifacts repositories create lykke-registry \
  --repository-format=docker --location=us-central1

gcloud sql instances create lykke-db \
  --database-version=POSTGRES_16 --tier=db-f1-micro \
  --region=us-central1 --storage-size=10GB --storage-type=HDD \
  --no-backup --root-password="$DB_PASS" --edition=ENTERPRISE

gcloud sql databases create robot --instance=lykke-db
gcloud sql users set-password postgres --instance=lykke-db --password="$DB_PASS"

for s in openai-api-key jwt-secret admin-password db-password; do
  gcloud secrets create $s --replication-policy=automatic
done
printf '%s' "$OPENAI_API_KEY_VALUE" | gcloud secrets versions add openai-api-key --data-file=-
printf '%s' "$JWT"                  | gcloud secrets versions add jwt-secret --data-file=-
printf '%s' "$ADMIN_PW"             | gcloud secrets versions add admin-password --data-file=-
printf '%s' "$DB_PASS"              | gcloud secrets versions add db-password --data-file=-

SA=$(gcloud projects describe lykke-food --format="value(projectNumber)")-compute@developer.gserviceaccount.com
for s in openai-api-key jwt-secret admin-password; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

### 4. Build + push images (via Cloud Build)

```bash
# API
gcloud builds submit --config=<(cat <<'EOF'
steps:
  - name: gcr.io/cloud-builders/docker
    args: [build, -f, apps/api/Dockerfile, -t,
           us-central1-docker.pkg.dev/$PROJECT_ID/lykke-registry/api:latest, .]
images: [us-central1-docker.pkg.dev/$PROJECT_ID/lykke-registry/api:latest]
options: { logging: CLOUD_LOGGING_ONLY }
timeout: 1200s
EOF
) .

# Web (mesmo padrão com apps/web/Dockerfile)
```

### 5. Aplicar migrations (via Cloud SQL Auth Proxy local)

```bash
curl -o /tmp/cloud-sql-proxy \
  https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.darwin.arm64
chmod +x /tmp/cloud-sql-proxy
/tmp/cloud-sql-proxy --port 5433 lykke-food:us-central1:lykke-db &

DATABASE_URL="postgresql://postgres:$DB_PASS@127.0.0.1:5433/robot?schema=public" \
  pnpm --filter @robot/api exec prisma migrate deploy
```

### 6. Deploy Cloud Run (API)

Env file `/tmp/cloudrun-api-env.yaml` (para escapar `&` do DATABASE_URL):

```yaml
NODE_ENV: production
HOST: 0.0.0.0
ADMIN_EMAIL: admin@lykke.food
CORS_ORIGIN: "*"
OPENAI_REALTIME_MODEL: gpt-4o-realtime-preview
OPENAI_VOICE: shimmer
BRIDGE_REALTIME_INSTRUCTIONS: "…"
DATABASE_URL: "postgresql://postgres:DB_PASS@/robot?host=/cloudsql/lykke-food:us-central1:lykke-db&schema=public"
```

Deploy:

```bash
gcloud run deploy api \
  --image=us-central1-docker.pkg.dev/lykke-food/lykke-registry/api:latest \
  --region=us-central1 --platform=managed --allow-unauthenticated \
  --add-cloudsql-instances=lykke-food:us-central1:lykke-db \
  --env-vars-file=/tmp/cloudrun-api-env.yaml \
  --set-secrets="OPENAI_API_KEY=openai-api-key:latest,JWT_SECRET=jwt-secret:latest,ADMIN_PASSWORD=admin-password:latest" \
  --min-instances=0 --max-instances=3 --cpu=1 --memory=512Mi --timeout=3600
```

### 7. Deploy Cloud Run (Web)

Após anotar a URL da API (`https://api-XXXX-uc.a.run.app`), extrai só o
hostname (sem `https://`) e passa como `API_UPSTREAM`:

```bash
API_HOST=api-XXXX-uc.a.run.app

gcloud run deploy web \
  --image=us-central1-docker.pkg.dev/lykke-food/lykke-registry/web:latest \
  --region=us-central1 --platform=managed --allow-unauthenticated \
  --set-env-vars="API_UPSTREAM=$API_HOST,API_SCHEME=https" \
  --min-instances=0 --max-instances=3 --memory=256Mi --port=80
```

### 8. Bootstrap admin

```bash
curl -X POST https://api-XXXX-uc.a.run.app/api/auth/bootstrap
```

Usa `ADMIN_EMAIL=admin@lykke.food` e a password do secret `admin-password`.

## URLs resultantes

- **Admin**: `https://web-XXXX-uc.a.run.app`
- **TV de um bridge**: `https://web-XXXX-uc.a.run.app/tv/bridge/<bridgeId>`
- **API** (direto, uso do bridge WS): `https://api-XXXX-uc.a.run.app`

O bridge local (no Mac/Pi) roda apontando para a API:

```
# apps/bridge/.env (simlink do raiz)
API_WS_URL=wss://api-XXXX-uc.a.run.app/ws/bridge
BRIDGE_TOKEN=<token gerado pelo admin web>
```

## Debug / operação do dia-a-dia

```bash
# Logs da API
gcloud run services logs read api --region=us-central1 --limit=50

# Últimos builds
gcloud builds list --limit=5

# Conectar no banco via proxy local (pra psql, dump, etc.)
/tmp/cloud-sql-proxy --port 5433 lykke-food:us-central1:lykke-db

# Subir nova versão da API/Web após mudanças em código
gcloud builds submit --config=/tmp/cloudbuild-api.yaml .
gcloud run deploy api --image=us-central1-docker.pkg.dev/lykke-food/lykke-registry/api:latest --region=us-central1
```

## Notas importantes

### WebSocket
Cloud Run suporta WS (HTTP/2), timeout de idle até 60 min. Configurei
`--timeout=3600` na API. Nginx do web tem `proxy_read_timeout 3600s`.

### Cloud SQL connection
API conecta via Unix socket em `/cloudsql/<connectionName>` (sem VPC connector
nem IP público exposto). Flag `--add-cloudsql-instances` no deploy monta o
socket no container.

### Shared packages
`@robot/shared` e `@robot/protocol` são compilados (`tsc → dist/`) durante o
build do Docker da API, porque em produção o Node não consegue importar
`.ts` diretamente (só o tsx watch do dev faz isso).

### Escala
Min instances = 0 → scale-to-zero (cold start ~2-3s na primeira requisição
depois de ficar ocioso). Se quiser sempre quente: `--min-instances=1`
(custa ~US$4/mês por serviço).
