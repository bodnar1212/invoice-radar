FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

CMD ["node", "index.js"]
