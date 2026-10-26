# The actor's image: Node 24, libfx and the actor's source. lib/chats.ts starts every chat's
# sandbox from it. Build and push: vercel vcr build docker actor fx0-actor --push
FROM node:24-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.ts design.ts instructions.ts turn-budget.ts ./
