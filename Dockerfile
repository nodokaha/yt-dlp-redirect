# Use the latest Node.js image
FROM node:latest

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install latest Deno
RUN curl -fsSL https://deno.land/install.sh | sh

# Add Deno to PATH
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# Install latest yt-dlp
RUN pip3 install --break-system-packages -U --pre yt-dlp

# Set the working directory inside the container
WORKDIR /app

# Copy package files first for better layer caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application files
COPY . .

# Build the application
#RUN npm run build

# Expose the default app port (adjust if needed)
EXPOSE 3000

# Start the application when the container launches
#CMD ["npm", "start"]
CMD ["npm", "run", "dev"]
