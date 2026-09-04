function toRepositoryJob(job) {
  return {
    id: job.id,
    status: job.status,
    kind: job.kind,
    orderId: job.orderId,
    printerId: job.printerId,
    printerHost: job.printerHost,
    printerPort: job.printerPort,
    errorMessage: job.errorMessage,
    requestedAt: job.requestedAt,
    payload: job,
  };
}

export async function persistSqlPrimaryPrintBatch(options = {}) {
  const payloads = (Array.isArray(options.payloads) ? options.payloads : []).filter(
    (payload) => payload && typeof payload === "object",
  );
  if (payloads.length === 0) return { jobs: [], durationMs: 0 };
  if (typeof options.buildJob !== "function") {
    throw new Error("persistSqlPrimaryPrintBatch richiede buildJob.");
  }
  if (typeof options.persistJobFile !== "function") {
    throw new Error("persistSqlPrimaryPrintBatch richiede persistJobFile.");
  }
  if (typeof options.repository?.enqueueMany !== "function") {
    throw new Error("persistSqlPrimaryPrintBatch richiede enqueueMany.");
  }

  const now = typeof options.now === "function" ? options.now : Date.now;
  const startedAt = now();
  const jobs = payloads.map((payload, index) => options.buildJob(payload, index));
  for (let index = 0; index < jobs.length; index += 1) {
    await options.persistJobFile(jobs[index], payloads[index]);
  }
  options.repository.enqueueMany(jobs.map(toRepositoryJob));
  return { jobs, durationMs: Math.max(0, now() - startedAt) };
}
