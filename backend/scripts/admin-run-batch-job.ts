import { runAdminRunBatchJob } from '../src/batch/batch-admin-runner';

if (require.main === module) {
  runAdminRunBatchJob(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;

    if (error instanceof Error) {
      console.error(`batch job failed: ${error.message}`);
      return;
    }

    console.error('batch job failed.');
  });
}
