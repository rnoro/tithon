# %%
get_ipython().run_line_magic("matplotlib", "inline")
import matplotlib.pyplot as plt
from IPython.display import display

print("BEFORE_FIG")
fig, ax = plt.subplots()
ax.plot([1, 2, 3])
display(fig)
plt.close(fig)
print("AFTER_FIG")
