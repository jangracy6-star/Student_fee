# Use a base image with Node.js and all required dependencies for Puppeteer/Chromium
FROM ghcr.io/puppeteer/puppeteer:latest

# Switch to root user to copy files and set permissions if needed
USER root

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install application dependencies
# We use npm ci for predictable builds if package-lock is present, otherwise npm install
RUN npm install

# Copy the rest of the application files
COPY . .

# Set environment variables for Puppeteer
# The image we're using already includes Chromium, so we tell Puppeteer to use it
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
