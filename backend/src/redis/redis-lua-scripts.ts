// Keep ownership-sensitive Redis operations centralized so compare-and-delete
// and compare-and-expire semantics cannot drift between consumers.
export const REDIS_COMPARE_AND_DELETE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export const REDIS_COMPARE_AND_EXPIRE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

// Uses Redis TIME and updates the next slot in one atomic EVAL. A negative
// result means the wait exceeds maxWait and, importantly, leaves the key
// untouched.
export const REDIS_RESERVE_NEXT_AVAILABLE_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local current = tonumber(redis.call('GET', KEYS[1])) or 0
local localFloorDelay = tonumber(ARGV[4])
local slot = math.max(now, current, now + localFloorDelay)
local delay = slot - now
local maxWait = tonumber(ARGV[2])
if delay > maxWait then
  return {-1, now, slot}
end
local nextAt = slot + tonumber(ARGV[1])
redis.call('SET', KEYS[1], tostring(nextAt), 'PX', ARGV[3])
return {delay, now, slot}
`;

// Writes a candle response only while both the distributed loader lock and
// the generation snapshot still belong to the caller. Missing generation is
// generation zero. Return codes: 1 stored, -1 lock lost, -2 generation changed.
export const REDIS_SET_CANDLE_IF_OWNER_AND_GENERATION_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return -1
end
local generation = tonumber(redis.call('GET', KEYS[2])) or 0
if generation ~= tonumber(ARGV[2]) then
  return -2
end
redis.call('SET', KEYS[3], ARGV[3], 'EX', ARGV[4])
return 1
`;
