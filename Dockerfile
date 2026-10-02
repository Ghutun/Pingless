FROM mcr.microsoft.com/playwright:v1.33.8-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 10000
CMD ["node", "bot.js"]   
