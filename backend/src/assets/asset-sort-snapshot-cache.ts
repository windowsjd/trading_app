// Short first-page reuse, long immutable pagination. Neither lifetime slides.
export const ASSET_SORT_REUSE_SECONDS = 2;
export const ASSET_SORT_TTL_SECONDS = 600;
export const ASSET_SORT_MAX_SNAPSHOTS = 200;
// Separate namespace: legacy user snapshots can contain admin diagnostics.
export const ASSET_SORT_CACHE_PREFIX = 'assets:sort:public:v1:';

/** Atomic bounded publication using the existing Redis connection. This is not
 * a build lock: parallel instances may publish distinct immutable tokens. */
export const STORE_ASSET_SORT_SNAPSHOT = `
local prefix = ARGV[1]
local token = ARGV[2]
local payload = ARGV[3]
local ttl = tonumber(ARGV[4])
local reuse = tonumber(ARGV[5])
local maximum = tonumber(ARGV[6])
local now = tonumber(ARGV[7])
redis.call('SET', KEYS[1], payload, 'EX', ttl)
redis.call('SET', KEYS[2], token, 'EX', reuse)
redis.call('ZADD', KEYS[3], now, token)
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - ttl * 1000)
local overflow = redis.call('ZCARD', KEYS[3]) - maximum
if overflow > 0 then
  local oldest = redis.call('ZRANGE', KEYS[3], 0, overflow - 1)
  for _, oldToken in ipairs(oldest) do
    local oldKey = prefix .. oldToken
    local oldPayload = redis.call('GET', oldKey)
    if oldPayload then
      local valid, oldSnapshot = pcall(cjson.decode, oldPayload)
      if valid and type(oldSnapshot) == 'table' and type(oldSnapshot.key) == 'string' then
        local oldLatest = prefix .. 'latest:' .. redis.sha1hex(oldSnapshot.key)
        if redis.call('GET', oldLatest) == oldToken then redis.call('DEL', oldLatest) end
      end
    end
    redis.call('DEL', oldKey)
    redis.call('ZREM', KEYS[3], oldToken)
  end
end
redis.call('EXPIRE', KEYS[3], ttl)
return 1
`;
