# Imagem oficial do Playwright: já vem com Chromium + todas as libs de sistema
# necessárias (libnss3, libatk, fonts, etc). Evita o erro "Executable doesn't exist".
# Versão da imagem alinhada com "playwright": "^1.40.0" do package.json.
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copia apenas os manifests primeiro para aproveitar cache de camadas do Docker
COPY package*.json ./

# --omit=dev evita instalar dependências de desenvolvimento no container final
RUN npm install --omit=dev

# Garante que o Chromium está instalado mesmo se o postinstall do npm falhar
# silenciosamente (redundância segura, não atrasa muito o build por já estar cacheado)
RUN npx playwright install --with-deps chromium

# Copia o resto do código da aplicação (inclui bot.js, public/, etc)
COPY . .

# Cria os diretórios que o bot.js espera em runtime (logs, screenshots)
RUN mkdir -p logs screenshots public

# Railway injeta a variável PORT automaticamente; bot.js já lê process.env.PORT
EXPOSE 3000

CMD ["node", "bot.js"]
