import type { UserRole } from '../../models/dto/user';

/**
 * 관리자 전용 콘솔 (2026-11-13) is shown to `admin` only — not `operator`, whose
 * existing server permissions stay as they are. A role that could not be read
 * (null/undefined) is never an admin. This only decides what the app shows;
 * the server re-reads the role from the database on every request.
 */
export const isAdminRole = (role: UserRole | null | undefined) => role === 'admin';
