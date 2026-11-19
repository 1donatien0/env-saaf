# Validate an Express app at startup

From the repository root, use Node.js 18 or newer to install and run the example.

```sh
cd examples/express
npm install
node server.js
```

With the defaults, the server listens on `127.0.0.1:3000`. From another terminal, request its health endpoint.

```sh
curl http://127.0.0.1:3000/health
```

The response is `{"ok":true,"debug":false}`. `validateEnv` supplies a numeric `PORT` for `listen` and a boolean `APP_DEBUG` for the response. Set `PORT=0` to let the operating system select a free port. Use the address printed by the server.

Stop the server with Ctrl+C. From the same directory, try an invalid port. This command works in Bash, PowerShell, and Command Prompt.

```sh
node -e "process.env.PORT = 'invalid'; require('./server')"
```

The app prints `Invalid configuration. Set PORT to an integer from 0 to 65535 and APP_DEBUG to true or false.` to stderr and exits with code 1 before opening a socket. The message describes the expected inputs without logging the raw environment values.
