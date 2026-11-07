import type { UserRole } from '../../models/dto/user';

/**
 * The community's operator tools (삭제, 계정 관리) are offered to the
 * session's operator/admin role only. A display gate: the server's
 * OperatorGuard decides every operator call against the current DB role.
 */
export const canManageCommunity = (role: UserRole | null | undefined) => role === 'operator' || role === 'admin';
