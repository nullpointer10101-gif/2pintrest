FROM ghcr.io/puppeteer/puppeteer:latest

# Copy your bot code into the container
WORKDIR /app
COPY package*.json ./

# Install dependencies (running as the non-root puppeteer user)
RUN npm install

# Copy the rest of the application files
COPY . .

# Start the bot in continuous cron mode
CMD ["node", "index.js", "--cron"]
