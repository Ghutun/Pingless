FROM mcr.microsoft.com/playwright:v1.63.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 10000
CMD ["node", "bot.js"]   
