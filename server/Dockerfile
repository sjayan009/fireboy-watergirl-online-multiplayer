FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY server/package*.json ./
RUN npm install

COPY server/ ./
COPY public/ ./public/

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "run", "start:tsx"]
