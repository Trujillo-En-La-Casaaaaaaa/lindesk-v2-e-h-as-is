FROM node:22-alpine
WORKDIR /app
COPY dist ./dist
ENV NODE_ENV=production
CMD ["node", "dist/server.js"]
