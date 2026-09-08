# Vectora

A modern, self-hosted Azure Service Bus explorer — a lightweight alternative to Service Bus Explorer.

![Screenshot](assets/screenshot.png)

## Features

- 🧪 **Fully supports Azure Service Bus Emulator**
- 🔍 Browse queues, topics, and subscriptions
- 📨 Send and receive messages
- 🔐 Secure connection management with encrypted storage
- 🎨 Modern web interface with Monaco editor for message editing
- 🤖 **Built-in MCP server** — let AI agents browse and interact your Service Bus ([docs](docs/MCP.md))
- 🐳 Easy deployment with Docker

## Tech Stack

- **Backend:** .NET 10, Minimal API
- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **Editor:** Monaco Editor

## Quick Start

### Using Docker Compose (Recommended)

1. Create a `docker-compose.yml` file:

   ```yaml
   services:
     vectora:
       image: lyubomirhristovv/vectora:latest
       restart: unless-stopped
       ports:
         - "8080:8080"
       volumes:
         - vectora-data:/data
       environment:
         - VECTORA_PASSWORD=your-secure-password

   volumes:
     vectora-data:
   ```

2. Start the application:
   ```bash
   docker compose up -d
   ```

3. Open your browser and navigate to [http://localhost:8080](http://localhost:8080)

### Configuration

| Environment Variable | Description
|---------------------|-------------|
| `VECTORA_PASSWORD` | [Optional] Password for authentication

## Navigating the application
The application remembers your connections, so you don't have to specify them everytime, as long as you have a persistant volume (for SQLite).  
When you open up the application for the first time, if you have specified a password, you'll be greeted with the login screen, otherwise, sent directly to the explorer UI.  

In the explorer UI, you can:
- switch seemlessly between connections
- search entities
- select entities on the left panel and see their messages
- switch to DLQ and see DLQ messages
- consume messages in queue/subscription or DLQ
- return DLQ messages to the queue/subscription
- edit and delete queues/topics/subscriptions, by sliding the entity to the left side, revealing a menu for that entity
- adjust the timeout of long operations

### First time setup
You need to set up at least one Service Bus connection, in order for the explorer interface to show up.  
1. Navigate the dropdown at the top menu
2. Press **Manage Connections**
3. Press **Add Connection**
4. Fill in **Connection Name** and **Connection String**
5. [Optional] For a Service Bus emulator connection, include `UseDevelopmentEmulator=true` in the connection string.
6. Press **Save**
7. You can now select the connection from the dropdown and see its entities

For the emulator connections, you can place the default connection string, specified by Microsoft [in the documentation](https://learn.microsoft.com/en-us/azure/service-bus-messaging/test-locally-with-service-bus-emulator)  

```
Endpoint=sb://<your service bus emulator container>;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;
```

The purpose of requesting connection string for the emulator, is that you can choose to have a shared emulator, inside a virtual private network. In that case, the endpoint will be different.

## MCP server (for AI agents)

Vectora ships with a built-in **MCP (Model Context Protocol) server**, so AI agents can
connect to Service Bus — list connections and entities, peek
active and dead-letter messages (with full data), and send messages.

Enable it in **Settings → MCP Server**: flip it on, optionally set an API key, then choose which
connections agents may read and which they may send to. Point your agent at `<your-host>/mcp`.
Reads are peek-only (non-destructive), and nothing is exposed until you opt a connection in.

There's also a ready-made [drop-in skill](docs/mcp-skill/SKILL.md) that teaches an agent exactly
what it can fetch and how — including asking you for the MCP key when it can't reach the server.

👉 **Full guide: [docs/MCP.md](docs/MCP.md)**

## Development
You are assuming correctly, it is an AI project. But also one that I'm using every single day.  
It's very important for me that this project works correctly and it outperforms the alternatives.  
Yes, it's not perfect.  
Yes, AI generated a lot of redundant and unoptimized code.  
It is a tool, not an enterprise project. It gets the job done.

### Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Node.js 20+](https://nodejs.org/)

### Backend

```bash
cd src/Vectora.Api
dotnet run
```

### Frontend
Make sure to copy and rename the `/Vectora.Client/.env.example` file to `.env.local` and adjust the `VITE_API_URL` value to your backend instance address.

```bash
cd src/Vectora.Client
npm install
npm run dev
```
