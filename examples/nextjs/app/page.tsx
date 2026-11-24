export default function Page() {
  return (
    <main>
      <h1>env-saaf Next.js example</h1>
      <p>The server validated its environment with env-saaf before this page was served.</p>
      <p>Remove <code>DATABASE_URL</code> from <code>.env.local</code> and restart to see it fail.</p>
    </main>
  );
}
