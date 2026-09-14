import { ConsoleLogger } from '@nestjs/common';
import { recordAdminApplicationLog } from './admin-diagnostics';

/**
 * Keeps Nest's normal ConsoleLogger behavior and mirrors only logs emitted
 * inside the current HTTP AsyncLocalStorage context into its bounded buffer.
 * Background logs and logs from other requests never enter that buffer.
 */
export class AdminDiagnosticLogger extends ConsoleLogger {
  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(message, ...optionalParams);
    recordAdminApplicationLog('info', message, optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(message, ...optionalParams);
    recordAdminApplicationLog('warn', message, optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(message, ...optionalParams);
    recordAdminApplicationLog('error', message, optionalParams);
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(message, ...optionalParams);
    recordAdminApplicationLog('debug', message, optionalParams);
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(message, ...optionalParams);
    recordAdminApplicationLog('debug', message, optionalParams);
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(message, ...optionalParams);
    recordAdminApplicationLog('error', message, optionalParams);
  }
}
