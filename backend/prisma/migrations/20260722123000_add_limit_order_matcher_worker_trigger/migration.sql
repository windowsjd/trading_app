-- The matcher is a dedicated long-running worker, not a scheduler-tick job.
ALTER TYPE "OpsJobTrigger" ADD VALUE IF NOT EXISTS 'worker';
