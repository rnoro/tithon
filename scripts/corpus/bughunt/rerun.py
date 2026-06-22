# %%
import builtins
builtins._rr = getattr(builtins, "_rr", 0) + 1
print(f"VALUE {builtins._rr}")
