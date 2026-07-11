export type KisTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  access_token_token_expired?: string;
  expires_at?: string;
  [key: string]: unknown;
};

export type ParsedKisTokenResponse = {
  accessToken: string;
  tokenType: string | null;
  expiresInSeconds: number | null;
  expiresAt: Date | null;
  receivedAt: Date | null;
};

export type KisApprovalKeyResponse = {
  approval_key?: string;
  expires_in?: number | string;
  expires_at?: string;
  approval_key_expired?: string;
  approval_key_token_expired?: string;
  approval_key_token_expired_at?: string;
  [key: string]: unknown;
};

export type ParsedKisApprovalKeyResponse = {
  approvalKey: string;
  expiresInSeconds: number | null;
  expiresAt: Date | null;
  receivedAt: Date | null;
};

export type KisLowLevelCallResult<T> =
  | {
      state: 'skipped';
      reason: 'KIS_REST_BASE_URL_MISSING' | 'KIS_WS_BASE_URL_MISSING';
    }
  | {
      state: 'available';
      response: T;
      receivedAt: Date;
    };

export type KisLowLevelCallWithMetadataResult<T> =
  | Extract<KisLowLevelCallResult<T>, { state: 'skipped' }>
  | {
      state: 'available';
      response: T;
      receivedAt: Date;
      /** Lower-case response headers. Credentials are request-only and absent. */
      headers: Readonly<Record<string, string>>;
      trCont: string | null;
    };
