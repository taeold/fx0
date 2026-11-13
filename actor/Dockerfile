FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.ts design.ts instructions.ts turn-budget.ts ./
