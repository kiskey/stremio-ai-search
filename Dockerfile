FROM node:23

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

EXPOSE 7000

ENV NODE_ENV=development
ENV ENABLE_LOGGING=true

RUN mkdir -p logs

CMD ["node", "server.js"]
