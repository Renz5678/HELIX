import ctypes,json,sys
engine=ctypes.CDLL(sys.argv[1]);name=sys.argv[2];fn=getattr(engine,'helix_'+name);fn.restype=ctypes.c_void_p;fn.argtypes=[ctypes.c_char_p]*(1 if name=='analyze' else 2);engine.helix_free_result.argtypes=[ctypes.c_void_p]
args=[open(path,'rb').read() for path in sys.argv[3:]]
p=fn(*args)
if not p:raise RuntimeError('C engine returned NULL')
try:print(ctypes.string_at(p).decode())
finally:engine.helix_free_result(p)
