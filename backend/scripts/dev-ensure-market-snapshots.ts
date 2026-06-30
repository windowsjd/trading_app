import {
  printScriptFailure,
  runProviderIngestionCheck,
} from './dev-run-provider-ingestions';

if (require.main === module) {
  runProviderIngestionCheck(process.argv.slice(2), {
    title: 'Market snapshot ensure result',
  }).catch((error: unknown) => {
    process.exitCode = 1;
    printScriptFailure('market snapshot ensure failed', error);
  });
}
