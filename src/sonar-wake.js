// Starts an on-demand SonarQube before a scan and waits until it answers UP.
//
// The homelab stops SonarQube's containers after 20 idle minutes, so a scan
// must wake it first. `docker start` on a running container is a no-op (the
// API answers 304, the CLI exits 0), so this is also safe when SonarQube is
// always on. The start is repeated on every poll: an idle-stop landing between
// two polls would otherwise leave us waiting on a stopped server. Nothing here
// stops SonarQube again; the idle-stop owns that.
//
// Dependencies are passed in so the loop is testable without Docker or a
// network: `docker(args)` resolves to { code, output } like runContainer,
// `fetchImpl` is fetch, `sleep(ms)` and `now()` drive time.
export async function wakeSonar({
  hostUrl,
  containers,
  timeoutMs,
  intervalMs = 5000,
  docker,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
}) {
  const statusUrl = `${hostUrl.replace(/\/+$/, "")}/api/system/status`;
  const deadline = now() + timeoutMs;
  let last = "no response";
  for (;;) {
    // One container per call, in order: the database before the server that
    // needs it.
    for (const name of containers) {
      const { code, output } = await docker(["start", name]);
      if (code !== 0) throw new Error(`docker start ${name} failed: ${output.trim()}`);
    }
    try {
      const res = await fetchImpl(statusUrl, { signal: AbortSignal.timeout(5000) });
      const body = await res.json();
      if (body.status === "UP") return;
      last = `status ${body.status}`;
    } catch (err) {
      last = err.message; // connection refused while the JVM boots
    }
    if (now() >= deadline) {
      throw new Error(
        `SonarQube at ${hostUrl} not UP after ${Math.round(timeoutMs / 1000)}s (last: ${last})`
      );
    }
    await sleep(intervalMs);
  }
}
