// Reads the quality-gate result of a project's latest SonarQube analysis.
//
// A scan is asynchronous: the scanner uploads a report and exits, and
// SonarQube's compute engine processes it afterwards. So a gate read straight
// after sonar_scan can still describe the previous analysis; `pending` says
// whether a task for the project is queued or running, and `lastTask` which
// analysis the gate belongs to. Nothing here polls: calling again is the poll.
//
// `fetchImpl` is passed in so this is testable without a SonarQube.

// The project key from sonar-project.properties text, or null. Java
// properties allow `key=value`, `key: value` and `key value`.
export function projectKeyFrom(propertiesText) {
  for (const raw of propertiesText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const m = /^sonar\.projectKey\s*[=:\s]\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

export async function qualityGate({ hostUrl, token, projectKey, fetchImpl = fetch }) {
  const base = hostUrl.replace(/\/+$/, "");
  const get = async (path) => {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      let why = body.errors?.map((e) => e.msg).join("; ") || `HTTP ${res.status}`;
      // SonarQube documents the web API for user tokens; an analysis token
      // (global or project) is meant for running scans and may be refused here.
      if (res.status === 401 || res.status === 403) {
        why += " (reading the gate needs a token allowed to call the web API, e.g. a user token with Browse on the project)";
      }
      throw new Error(`SonarQube ${path.split("?")[0]}: ${why}`);
    }
    return body;
  };
  const key = encodeURIComponent(projectKey);
  const ce = await get(`/api/ce/component?component=${key}`);
  const gate = await get(`/api/qualitygates/project_status?projectKey=${key}`);
  const ps = gate.projectStatus ?? {};
  return {
    projectKey,
    status: ps.status ?? "NONE",
    pending: (ce.queue ?? []).length > 0,
    lastTask: ce.current
      ? { status: ce.current.status, submittedAt: ce.current.submittedAt, executedAt: ce.current.executedAt }
      : null,
    conditions: (ps.conditions ?? []).map((c) => ({
      metric: c.metricKey,
      status: c.status,
      actual: c.actualValue,
      comparator: c.comparator,
      threshold: c.errorThreshold,
    })),
  };
}
