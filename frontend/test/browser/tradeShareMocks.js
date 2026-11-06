// 수익 공유 fixture transport: the card and sheet read nothing from the network
// (the member's profile is seeded in the query cache); any read is a fixture bug.
export const apiClient = {
  get: async (path) => { throw new Error(`Unexpected fixture read: ${path}`); },
  post: async (path) => { throw new Error(`Unexpected fixture write: ${path}`); },
};
export const API_TIMEOUT_MS = 15000;
