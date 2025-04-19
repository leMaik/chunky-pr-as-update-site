FROM node:22-alpine AS build
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app
ADD package*.json /usr/src/app/
RUN npm ci
ADD . /usr/src/app

FROM node:22-alpine
WORKDIR /usr/src/app
COPY --from=build /usr/src/app /usr/src/app
CMD ["node", "index.mjs"]
