# 📡 Forex Scanner Web — Deploy no Render.com

## O que é isso?
Versão web do Forex Scanner v3, rodando 24h no Render.com com:
- ✅ Dashboard web em tempo real
- ✅ IA (Claude) analisando cada sinal
- ✅ Coleta de dados 24h por dia
- ✅ WebSocket para preços ao vivo (Finnhub)
- ✅ Alertas no Telegram
- ✅ API REST para exportar dados

## Como subir no Render

### 1. Suba o código no GitHub
```bash
git init
git add .
git commit -m "Forex Scanner Web"
git remote add origin https://github.com/SEU_USER/forex-scanner-web
git push -u origin main
```

### 2. Crie o serviço no Render
1. Acesse render.com → "New Web Service"
2. Conecte seu repositório GitHub
3. Render detecta o `render.yaml` automaticamente

### 3. Configure as variáveis de ambiente no Render
| Variável | Valor |
|---|---|
| `TWELVE_API_KEY` | Sua chave principal da Twelve Data |
| `TWELVE_EXTRA_KEYS` | Chaves extras separadas por vírgula |
| `FINNHUB_KEY` | d6lge5pr01qrq6i2kj3gd6lge5pr01qrq6i2kj40 |
| `TELEGRAM_TOKEN` | Token do seu bot Telegram |
| `TELEGRAM_CHAT_ID` | ID do seu chat/grupo |
| `ANTHROPIC_API_KEY` | Sua chave da API do Claude (IA) |

### 4. Deploy!
Clique em "Deploy" — em ~2 minutos estará rodando.

## API REST disponível
- `GET /api/status` — Status do scanner
- `GET /api/signals?limit=50` — Últimos sinais
- `GET /api/logs` — Logs do sistema
- `GET /api/ai` — Análises da IA
- `GET /api/winrate` — Win rate da sessão
- `GET /api/export` — Exportar tudo em JSON

## Estrutura
```
├── server.js          ← Servidor principal (Express + WebSocket)
├── src/
│   └── scannerEngine.js ← Motor do scanner (v3 original)
├── public/
│   └── index.html     ← Dashboard web
├── data/              ← Dados salvos (sinais, IA)
├── render.yaml        ← Configuração do Render
└── package.json
```
