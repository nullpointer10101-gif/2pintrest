FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root to install dependencies and copy files
USER root

# Copy your bot code into the container
WORKDIR /app
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Change ownership to the non-root puppeteer user, then switch back
RUN chown -R pptruser:pptruser /app
USER pptruser

# Start the bot in Web Server Mode (required for Render to detect an open port)
CMD ["node", "index.js", "--web"]
