# Validate a Next.js app at server startup

From the repository root, use Node.js 20.9 or newer to install and run the example.

```sh
cd examples/nextjs
npm install
cp .env.example .env.local
npm run dev
```

Open <http://localhost:3000>. `instrumentation.ts` calls `register()` once when the Node.js server boots, and `lib/env.ts` runs `validateEnv` before the first request: a missing or malformed value stops the server with the env-saaf message instead of failing inside a page.

Stop the server with Ctrl+C. Break the environment by emptying the required value and starting again.

```sh
# .env.local with DATABASE_URL= and AUTH_SECRET set
npm run dev
```

The server prints `Invalid environment variables:` with the key and the reason, then exits. `AUTH_SECRET` is marked `sensitive: true`, so its value is masked in that message.

`lib/env.ts` is server-only and must not be imported from a Client Component: Next inlines every `NEXT_PUBLIC_*` value into the browser bundle, and none of these values is public. Keep the schema in the server module and pass what a component needs as props.

For a production build, `npm run build` compiles without loading the environment (the page does not import `lib/env.ts`); `npm start` then validates it before serving.
