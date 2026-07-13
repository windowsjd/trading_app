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

// Atomic live 5m reducer. Decimal addition/comparison is implemented on
// fixed-scale strings, avoiding Lua double precision for financial values.
export const REDIS_APPLY_LIVE_CANDLE_EVENT_SCRIPT = `
local function digits(value)
  local text = tostring(value)
  local whole, fraction = string.match(text, '^(%d+)%.(%d+)$')
  if not whole then
    whole = text
    fraction = ''
  end
  fraction = string.sub(fraction .. '00000000', 1, 8)
  whole = string.gsub(whole, '^0+', '')
  if whole == '' then whole = '0' end
  return whole .. fraction
end

local function decimal_from_digits(value)
  value = string.gsub(value, '^0+', '')
  if value == '' then value = '0' end
  while string.len(value) <= 8 do value = '0' .. value end
  local split = string.len(value) - 8
  local whole = string.sub(value, 1, split)
  local fraction = string.sub(value, split + 1)
  whole = string.gsub(whole, '^0+', '')
  if whole == '' then whole = '0' end
  return whole .. '.' .. fraction
end

local function decimal_compare(left, right)
  local a = digits(left)
  local b = digits(right)
  if string.len(a) ~= string.len(b) then
    return string.len(a) < string.len(b) and -1 or 1
  end
  if a == b then return 0 end
  return a < b and -1 or 1
end

local function decimal_add(left, right)
  local a = digits(left)
  local b = digits(right)
  local width = math.max(string.len(a), string.len(b))
  a = string.rep('0', width - string.len(a)) .. a
  b = string.rep('0', width - string.len(b)) .. b
  local carry = 0
  local result = ''
  for index = width, 1, -1 do
    local sum = tonumber(string.sub(a, index, index)) + tonumber(string.sub(b, index, index)) + carry
    result = tostring(sum % 10) .. result
    carry = math.floor(sum / 10)
  end
  if carry > 0 then result = tostring(carry) .. result end
  return decimal_from_digits(result)
end

local function sequence_value(value)
  if value == cjson.null or value == nil then return nil end
  local text = tostring(value)
  return string.match(text, '([^:]+)$') or text
end

local function is_older(event, state)
  if event.eventTime < state.lastEventAt then return true end
  if event.eventTime > state.lastEventAt then return false end
  local incoming = sequence_value(event.sequence)
  local current = sequence_value(state.lastSequence)
  return incoming ~= nil and current ~= nil and decimal_compare(incoming, current) < 0
end

if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return cjson.encode({status='owner_lost'})
end
if redis.call('EXISTS', KEYS[4]) == 1 then
  return cjson.encode({status='duplicate'})
end

local event = cjson.decode(ARGV[4])
local raw = redis.call('GET', KEYS[2])
local state = raw and cjson.decode(raw) or cjson.decode(ARGV[5])
if state.ownerGeneration ~= ARGV[2] then
  return cjson.encode({status='generation_mismatch'})
end
if state.openTime ~= event.openTime or state.closeTime ~= event.closeTime then
  return cjson.encode({status='bucket_mismatch'})
end

local function persist(current)
  local encoded = cjson.encode(current)
  redis.call('SET', KEYS[2], encoded, 'EX', ARGV[6])
  local pointer = redis.call('GET', KEYS[3])
  local replacePointer = pointer == false
  if pointer then
    local previousRaw = redis.call('GET', pointer)
    if previousRaw == false then
      replacePointer = true
    else
      local previous = cjson.decode(previousRaw)
      replacePointer = previous.openTime <= current.openTime
    end
  end
  if replacePointer then redis.call('SET', KEYS[3], KEYS[2], 'EX', ARGV[7]) end
  redis.call('ZADD', KEYS[5], ARGV[9], KEYS[2])
end

redis.call('SET', KEYS[4], '1', 'EX', ARGV[8], 'NX')
if event.mode == 'delta' and state.baselineEventTime ~= cjson.null and state.baselineEventTime ~= nil and event.eventTime <= state.baselineEventTime then
  persist(state)
  return cjson.encode({status='baseline_covered', state=state})
end
local eventIsOlder = is_older(event, state)
if event.mode == 'absolute' and eventIsOlder then
  return cjson.encode({status='out_of_order', state=state})
end

local wasOutOfOrder = eventIsOlder

if event.mode == 'absolute' then
  state.open = event.absolute.open
  state.high = event.absolute.high
  state.low = event.absolute.low
  state.close = event.absolute.close
  state.volume = event.absolute.volume
  state.amount = event.absolute.amount
  state.complete = true
  state.sourceContinuity = true
  state.providerFinal = event.absolute.providerFinal
else
  if decimal_compare(event.price, state.high) > 0 then state.high = event.price end
  if decimal_compare(event.price, state.low) < 0 then state.low = event.price end
  if event.tradeQuantity ~= cjson.null and event.tradeQuantity ~= nil then
    if state.volume == cjson.null or state.volume == nil then
      state.volume = event.tradeQuantity
    else
      state.volume = decimal_add(state.volume, event.tradeQuantity)
    end
  end
  if event.amount ~= cjson.null and event.amount ~= nil then
    if state.amount == cjson.null or state.amount == nil then
      state.amount = event.amount
    else
      state.amount = decimal_add(state.amount, event.amount)
    end
  end
  if not eventIsOlder then
    state.close = event.price
  end
end

if not eventIsOlder then
  state.lastEventAt = event.eventTime
  state.lastSequence = event.sequence
  state.sourceUpdatedAt = event.eventTime
end
state.eventCount = state.eventCount + 1
state.revision = state.revision + 1
state.provisional = true
state.finalized = false

persist(state)
return cjson.encode({status=wasOutOfOrder and 'out_of_order' or 'updated', state=state})
`;

export const REDIS_MARK_LIVE_CANDLE_INCOMPLETE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local state = cjson.decode(raw)
if state.ownerGeneration ~= ARGV[1] then return 0 end
if state.finalized == true or state.providerFinal == true then return 2 end
state.complete = false
state.sourceContinuity = false
state.revision = state.revision + 1
redis.call('SET', KEYS[2], cjson.encode(state), 'EX', ARGV[2])
return 1
`;

export const REDIS_MARK_LIVE_CANDLE_FINALIZED_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local state = cjson.decode(raw)
if state.ownerGeneration ~= ARGV[1] or state.revision ~= tonumber(ARGV[2]) then return 0 end
state.provisional = false
state.finalized = true
state.complete = true
state.revision = state.revision + 1
redis.call('SET', KEYS[2], cjson.encode(state), 'EX', ARGV[3])
redis.call('ZREM', KEYS[3], KEYS[2])
return cjson.encode(state)
`;

// Finalizes a live candle state whose owner generation no longer holds the
// provider lease (the owning process died or lost the lease). Safe because
// writes to a state are gated on the lease matching the state's generation:
// once the lease value differs (or is absent), no producer can mutate this
// state anymore. Returns -1 while the original owner still holds the lease
// (the normal owner-guarded finalize path must be used), 0 when the state is
// gone or the revision moved, else the finalized state JSON.
export const REDIS_TAKEOVER_FINALIZE_LIVE_CANDLE_SCRIPT = `
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local state = cjson.decode(raw)
local lease = redis.call('GET', KEYS[1])
if lease == state.ownerGeneration then return -1 end
if state.revision ~= tonumber(ARGV[1]) then return 0 end
state.provisional = false
state.finalized = true
state.complete = true
state.revision = state.revision + 1
redis.call('SET', KEYS[2], cjson.encode(state), 'EX', ARGV[2])
redis.call('ZREM', KEYS[3], KEYS[2])
return cjson.encode(state)
`;

export const REDIS_DISCARD_RECONCILED_LIVE_CANDLE_SCRIPT = `
local stateKey = redis.call('GET', KEYS[1])
if not stateKey then return 0 end
local raw = redis.call('GET', stateKey)
if not raw then
  redis.call('DEL', KEYS[1])
  return 0
end
local state = cjson.decode(raw)
if state.openTime ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], stateKey)
return 1
`;
