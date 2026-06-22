# %%
import builtins
builtins._c = getattr(builtins, "_c", 0) + 1
print(f"RUN {builtins._c}")

# %%
import builtins
builtins._c = getattr(builtins, "_c", 0) + 1
print(f"RUN {builtins._c}")
