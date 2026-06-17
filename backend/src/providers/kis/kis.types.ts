export type KisTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  access_token_token_expired?: string;
  [key: string]: unknown;
};

export type ParsedKisTokenResponse = {
  accessToken: string;
  tokenType: string | null;
  expiresInSeconds: number | null;
  expiresAt: Date | null;
};

export type KisApprovalKeyResponse = {
  approval_key?: string;
  [key: string]: unknown;
};

export type ParsedKisApprovalKeyResponse = {
  approvalKey: string;
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
