"""Read Linux timex with modes=0; never request a clock adjustment."""
import ctypes
import json
import time

class Timeval(ctypes.Structure):
    _fields_ = [('tv_sec', ctypes.c_long), ('tv_usec', ctypes.c_long)]

class Timex(ctypes.Structure):
    _fields_ = [('modes', ctypes.c_uint), ('offset', ctypes.c_long),
                ('freq', ctypes.c_long), ('maxerror', ctypes.c_long),
                ('esterror', ctypes.c_long), ('status', ctypes.c_int),
                ('constant', ctypes.c_long), ('precision', ctypes.c_long),
                ('tolerance', ctypes.c_long), ('time', Timeval),
                ('tick', ctypes.c_long), ('ppsfreq', ctypes.c_long),
                ('jitter', ctypes.c_long), ('shift', ctypes.c_int),
                ('stabil', ctypes.c_long), ('jitcnt', ctypes.c_long),
                ('calcnt', ctypes.c_long), ('errcnt', ctypes.c_long),
                ('stbcnt', ctypes.c_long), ('tai', ctypes.c_int),
                ('reserved', ctypes.c_int * 11)]

state = Timex()  # zero-initialized, including modes=0 (read-only).
libc = ctypes.CDLL(None, use_errno=True)
libc.adjtimex.argtypes = [ctypes.POINTER(Timex)]
libc.adjtimex.restype = ctypes.c_int
result = libc.adjtimex(ctypes.byref(state))
if result < 0:
    raise OSError(ctypes.get_errno(), 'read-only adjtimex failed')
data = {key: getattr(state, key) for key, _ in Timex._fields_
        if key not in ('time', 'reserved')}
data.update(returncode=result, structSize=ctypes.sizeof(state),
            frequencyPpm=state.freq / 65536, wallUnixNs=time.time_ns())
print(json.dumps(data, indent=2))
