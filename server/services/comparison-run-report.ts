import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db.js";
import { evalComparisonRuns, evalDatasetCases, evalDatasetOutputs, evalDatasetSubjects, evalExperiments, evalGenerations, evalJobs } from "../../shared/schema.js";

export async function buildComparisonRunReport(db: Db, runId: string) {
  const [run] = await db.select().from(evalComparisonRuns).where(eq(evalComparisonRuns.id, runId));
  if (!run) throw new Error(`Run ${runId} not found`);
  const [comparison] = await db.select().from(evalExperiments).where(eq(evalExperiments.id, run.comparisonId));
  if (!comparison) throw new Error(`Comparison ${run.comparisonId} not found`);

  const jobs = await db
    .select({ job: evalJobs, case: evalDatasetCases, subjectKey: evalDatasetSubjects.subjectKey })
    .from(evalJobs)
    .innerJoin(evalDatasetCases, eq(evalDatasetCases.id, evalJobs.caseId))
    .leftJoin(evalDatasetSubjects, eq(evalDatasetSubjects.id, evalDatasetCases.subjectId))
    .where(eq(evalJobs.runId, runId))
    .orderBy(asc(evalDatasetSubjects.subjectKey), asc(evalDatasetCases.caseKey));
  const caseIds = jobs.map((item) => item.case.id);
  const outputs = caseIds.length ? await db.select().from(evalGenerations).where(inArray(evalGenerations.jobId, jobs.map((item) => item.job.id))) : [];
  const current = caseIds.length ? await db.select().from(evalDatasetOutputs).where(inArray(evalDatasetOutputs.caseId, caseIds)) : [];

  return {
    comparison: {
      id: comparison.id,
      name: comparison.name,
      model: comparison.candidateModel,
      datasetId: comparison.datasetId,
      createdAt: comparison.createdAt,
    },
    run: {
      ...run,
      userCount: run.userKeys.length,
      coverage: { requested: run.requestedCases, completed: run.completedCases, failed: run.failedCases },
    },
    readings: jobs.map(({ job, case: datasetCase, subjectKey }) => ({
      jobId: job.id,
      subjectKey,
      caseKey: datasetCase.caseKey,
      readingType: datasetCase.readingType ?? datasetCase.track,
      readingSubtype: datasetCase.readingSubtype,
      status: job.status,
      error: job.lastError,
      inputSnapshot: datasetCase.inputSnapshot,
      currentReading: current.find((item) => item.caseId === datasetCase.id) ?? null,
      generatedReadings: outputs.filter((item) => item.jobId === job.id),
    })),
  };
}
