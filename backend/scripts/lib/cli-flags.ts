/**
 * Shared parser for the `--apply` / `--dry-run` safety contract used by the
 * recovery and Binance seed scripts.
 *
 * Rules:
 *  - `--apply` and `--dry-run` are mutually exclusive (both => validation error).
 *  - Neither flag defaults to DRY-RUN, so a bare invocation never writes; a
 *    write requires an explicit `--apply`.
 *  - Unknown flags are rejected so a typo (e.g. `--aply`) can never be silently
 *    treated as dry-run and skip an intended write, or vice versa.
 */

export type ApplyMode = 'apply' | 'dry-run';

export type ParsedApplyFlags = {
  mode: ApplyMode;
  apply: boolean;
  dryRun: boolean;
  skipProviderValidation: boolean;
};

export function parseApplyDryRunFlags(
  argv: readonly string[],
  options: { allowSkipProviderValidation?: boolean } = {},
): ParsedApplyFlags {
  const allowed = new Set(['--apply', '--dry-run']);
  if (options.allowSkipProviderValidation) {
    allowed.add('--skip-provider-validation');
  }

  for (const arg of argv) {
    if (!allowed.has(arg)) {
      throw new Error(
        `Unknown option: ${arg}. Allowed: ${[...allowed].join(', ')}`,
      );
    }
  }

  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');
  if (apply && dryRun) {
    throw new Error(
      '--apply and --dry-run cannot be combined; pass exactly one.',
    );
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    apply,
    dryRun,
    skipProviderValidation:
      Boolean(options.allowSkipProviderValidation) &&
      argv.includes('--skip-provider-validation'),
  };
}
