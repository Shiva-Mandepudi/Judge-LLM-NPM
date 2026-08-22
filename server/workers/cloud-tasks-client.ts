import { CloudTasksClient } from "@google-cloud/tasks";

let client: CloudTasksClient | undefined;

/**
 * Enqueues one Cloud Tasks push task per job. Cloud Tasks itself provides
 * the retry/backoff (configured on the queue, see docs/gcp-deployment.md)
 * and de-dup: task name is derived from the job's idempotency key, so
 * re-enqueuing the same job is a safe no-op (Cloud Tasks rejects duplicate
 * task names for a time window) rather than double-processing.
 */
export async function enqueueJobTask(jobId: string, idempotencyKey: string): Promise<void> {
  const project = process.env.GCP_PROJECT_ID;
  const location = process.env.CLOUD_TASKS_LOCATION;
  const queue = process.env.CLOUD_TASKS_QUEUE;
  const workerUrl = process.env.JUDGE_WORKER_URL;
  const serviceAccountEmail = process.env.CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT;
  if (!project || !location || !queue || !workerUrl || !serviceAccountEmail) {
    throw new Error("Cloud Tasks is not fully configured (GCP_PROJECT_ID, CLOUD_TASKS_LOCATION, CLOUD_TASKS_QUEUE, JUDGE_WORKER_URL, CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT).");
  }

  client ??= new CloudTasksClient();
  const parent = client.queuePath(project, location, queue);

  await client.createTask({
    parent,
    task: {
      name: `${parent}/tasks/${sanitizeTaskName(idempotencyKey)}`,
      httpRequest: {
        httpMethod: "POST",
        url: `${workerUrl}/internal/worker/run-job`,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ jobId })).toString("base64"),
        oidcToken: { serviceAccountEmail, audience: workerUrl },
      },
    },
  });
}

function sanitizeTaskName(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 500);
}
