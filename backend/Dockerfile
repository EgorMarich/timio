FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8787

# При старте контейнера: применяем схему к Postgres, наполняем демо-данными
# (идемпотентно - при повторном запуске пропускается), затем запускаем сервер.
CMD sh -c "npm run db:push -- --force && npm run db:seed && npm run start"
