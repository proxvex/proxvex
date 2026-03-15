import express from "express";
import { ApiUri, ITestScenarioResponse } from "@src/types.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

// ── Queue entry ──

interface QueueEntry {
  scenario: ITestScenarioResponse;
  vmId: number;
  hostname: string;
  stackName: string;
  status: "pending" | "running" | "completed" | "failed";
  workerId?: string;
}

// ── In-memory queue state (singleton, reset on init) ──

let queue: QueueEntry[] = [];
let initialized = false;

const VM_ID_START = 200;

// ── Helpers ──

function buildQueue(scenarios: ITestScenarioResponse[]): QueueEntry[] {
  let nextVmId = VM_ID_START;
  return scenarios.map((scenario) => {
    const vmId = nextVmId++;
    const stackName = scenario.id.split("/")[1] ?? "default";
    return {
      scenario,
      vmId,
      hostname: `${scenario.application}-${stackName}`,
      stackName,
      status: "pending",
    };
  });
}

/**
 * Check if a scenario's dependencies are all completed.
 */
function areDepsCompleted(entry: QueueEntry): boolean {
  const deps = entry.scenario.depends_on;
  if (!deps || deps.length === 0) return true;
  return deps.every((depId) => {
    const dep = queue.find((e) => e.scenario.id === depId);
    return dep?.status === "completed";
  });
}

/**
 * Cascade-fail all entries that transitively depend on a failed entry.
 */
function cascadeFail(failedId: string): void {
  const toFail = new Set<string>();
  const addDependents = (id: string) => {
    for (const entry of queue) {
      if (entry.status !== "pending") continue;
      const deps = entry.scenario.depends_on;
      if (deps && deps.includes(id)) {
        toFail.add(entry.scenario.id);
        addDependents(entry.scenario.id);
      }
    }
  };
  addDependents(failedId);
  for (const id of toFail) {
    const entry = queue.find((e) => e.scenario.id === id);
    if (entry) entry.status = "failed";
  }
}

// ── Route registration ──

export function registerTestQueueRoutes(app: express.Application): void {
  const jsonBody = express.json();

  // POST /api/test-queue/init — Initialize queue with all (or filtered) scenarios
  app.post(ApiUri.TestQueueInit, jsonBody, (req, res) => {
    try {
      const pm = PersistenceManager.getInstance();
      const allScenarios = pm.getTestScenarios();
      const filterIds = req.body?.scenarios as string[] | undefined;

      let scenarios = allScenarios;
      if (filterIds && filterIds.length > 0) {
        const filterSet = new Set(filterIds);
        scenarios = allScenarios.filter((s) => filterSet.has(s.id));
      }

      // Idempotent: only initialize if not already done
      if (!initialized) {
        queue = buildQueue(scenarios);
        initialized = true;
      }

      res.json({
        initialized: true,
        count: queue.length,
        scenarios: queue.map((e) => ({
          id: e.scenario.id,
          vmId: e.vmId,
          hostname: e.hostname,
          stackName: e.stackName,
        })),
      });
    } catch (err: unknown) {
      sendErrorResponse(res, err);
    }
  });

  // GET /api/test-queue/next — Get next ready scenario (deps completed)
  app.get(ApiUri.TestQueueNext, (req, res) => {
    if (!initialized) {
      res.status(400).json({ error: "Queue not initialized. POST /api/test-queue/init first." });
      return;
    }

    const workerId = String(req.query.workerId || "anonymous");

    // Find first pending entry whose deps are completed
    const ready = queue.find(
      (e) => e.status === "pending" && areDepsCompleted(e),
    );

    if (ready) {
      ready.status = "running";
      ready.workerId = workerId;
      res.json({
        scenario: ready.scenario,
        vmId: ready.vmId,
        hostname: ready.hostname,
        stackName: ready.stackName,
      });
      return;
    }

    // No ready entry — check if we're done or waiting
    const hasPending = queue.some((e) => e.status === "pending");
    const hasRunning = queue.some((e) => e.status === "running");

    if (hasPending || hasRunning) {
      // Still waiting for other workers to complete dependencies
      res.json({ wait: true });
    } else {
      // All done
      res.json({ done: true });
    }
  });

  // POST /api/test-queue/complete/:app/:variant — Mark scenario as completed
  app.post(ApiUri.TestQueueComplete, jsonBody, (req, res) => {
    const id = `${req.params.app}/${req.params.variant}`;
    const entry = queue.find((e) => e.scenario.id === id);
    if (!entry) {
      res.status(404).json({ error: `Scenario '${id}' not found in queue` });
      return;
    }
    entry.status = "completed";
    res.json({ id, status: "completed" });
  });

  // POST /api/test-queue/fail/:app/:variant — Mark scenario as failed (cascading)
  app.post(ApiUri.TestQueueFail, jsonBody, (req, res) => {
    const id = `${req.params.app}/${req.params.variant}`;
    const entry = queue.find((e) => e.scenario.id === id);
    if (!entry) {
      res.status(404).json({ error: `Scenario '${id}' not found in queue` });
      return;
    }
    entry.status = "failed";
    cascadeFail(id);

    const cascaded = queue
      .filter((e) => e.status === "failed" && e.scenario.id !== id)
      .map((e) => e.scenario.id);

    res.json({ id, status: "failed", cascadedFailures: cascaded });
  });

  // GET /api/test-queue/status — Get full queue status
  app.get(ApiUri.TestQueueStatus, (_req, res) => {
    const counts = { pending: 0, running: 0, completed: 0, failed: 0 };
    for (const e of queue) {
      counts[e.status]++;
    }

    res.json({
      initialized,
      total: queue.length,
      counts,
      entries: queue.map((e) => ({
        id: e.scenario.id,
        vmId: e.vmId,
        hostname: e.hostname,
        stackName: e.stackName,
        status: e.status,
        workerId: e.workerId,
      })),
    });
  });
}
