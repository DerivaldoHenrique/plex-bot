# PLEX Bot — Alertas e Registro de Execução via Telegram

Bot que lê seu plano diário do PLEX, envia alertas no Telegram no horário de cada atividade e registra a execução quando você responde.

## Funcionamento

```
05:50 → Bot envia: "👥 05:50 — Realização de dds com equipe"
Você responde: "ok" ou "05:52 06:18"
Bot atualiza: inicio_executado, fim_executado, status=EXECUTADO no PLEX
```

### Formatos de resposta aceitos

| Resposta | Comportamento |
|---|---|
| `ok` | Usa horários planejados |
| `05:52 06:18` | Início e fim reais |
| `05:52` | Início real, fim = hora atual |
| `desvio 05:52 06:18` | Marca como DESVIO |

### Comandos

| Comando | Ação |
|---|---|
| `/hoje` | Lista todas as atividades do dia com status |
| `/status` | Mostra atividade aguardando confirmação |
| `/pular` | Pula a confirmação atual |

---

## Configuração

### 1. Criar Bot no Telegram

1. Abra o Telegram e busque **@BotFather**
2. Envie `/newbot`
3. Dê um nome e username ao bot
4. Copie o **token** gerado

### 2. Obter seu Chat ID

1. Busque **@userinfobot** no Telegram
2. Envie qualquer mensagem
3. Copie o **Id** retornado

### 3. Configurar variáveis de ambiente

```bash
cp .env.example .env
```

Edite o arquivo `.env`:

```
PLEX_BASE_URL=https://plex.benellog.com.br
PLEX_EMAIL=henrique@bnel.com.br
PLEX_SENHA=sua_senha
TELEGRAM_BOT_TOKEN=seu_token_aqui
TELEGRAM_CHAT_ID=seu_chat_id_aqui
```

### 4. Instalar dependências

```bash
npm install
```

### 5. Testar localmente

```bash
npm start
```

---

## Deploy na nuvem (Railway) — notebook não precisa ficar ligado

### Opção A: Railway (recomendado, gratuito)

1. Acesse [railway.app](https://railway.app) e crie uma conta
2. Clique em **New Project → Deploy from GitHub repo**
3. Conecte este repositório (ou faça upload manual)
4. Vá em **Variables** e adicione todas as variáveis do `.env`
5. O bot inicia automaticamente e fica rodando 24/7

### Opção B: Render (alternativo, gratuito)

1. Acesse [render.com](https://render.com)
2. Crie um **Web Service** apontando para este repo
3. Start command: `node index.js`
4. Adicione as variáveis de ambiente
5. Deploy

---

## Arquitetura

```
Railway/Render (nuvem, 24/7)
       │
       ├── Cron (todo minuto)
       │     └── Verifica atividades do PLEX
       │           └── Se HH:MM == hora atual → envia alerta Telegram
       │
       └── Webhook Telegram
             └── Recebe resposta do usuário
                   └── Atualiza execução no PLEX via API
```

O notebook **não precisa estar ligado** — o serviço roda 100% na nuvem.
