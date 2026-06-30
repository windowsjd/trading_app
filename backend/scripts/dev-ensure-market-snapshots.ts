import { runProviderIngestionCheck } from './dev-run-provider-ingestions';

if (require.main === module) {
  runProviderIngestionCheck(process.argv.slice(2), {
    title: 'Market snapshot ensure result',
  }).catch((error: unknown) => {
    process.exitCode = 1;
    if (error instanceof Error) {
      console.error(`market snapshot ensure failed: ${error.message}`);
      return;
    }

    console.error('market snapshot ensure failed.');
  });
}
